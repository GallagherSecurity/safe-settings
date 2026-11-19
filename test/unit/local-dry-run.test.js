/* eslint-disable no-undef */
const yaml = require('js-yaml')
const {
  run,
  parseCliArgs,
  withDefaultRestrictedRepos,
  getChangedConfigs,
  createOctokit,
  createLogger,
  formatReport
} = require('../../local-dry-run')
const Settings = require('../../lib/settings')

const ORG = 'my-org'
const BRANCH = 'my-branch'
const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567'
const BASE_SHA = 'fedcba9876543210fedcba9876543210fedcba98'
const MERGE_BASE_SHA = '1111111111111111111111111111111111111111'

// Repos in the fake org. `suborg` is the value of the `suborg` custom property.
const REPOS = [
  { name: 'repo-a1', suborg: 'a' },
  { name: 'repo-a2', suborg: 'a' },
  { name: 'repo-archived', suborg: 'a', archived: true },
  { name: 'repo-b' },
  { name: 'repo-c1', suborg: 'c' },
  { name: 'repo-none' },
  { name: 'repo-team' }
]

const SETTINGS_YML = { labels: [{ name: 'org-label', color: 'ffffff' }] }

const SUBORGS = {
  'suborg-a.yml': { suborgproperties: [{ suborg: 'a' }] },
  'suborg-b.yml': { suborgrepos: ['repo-b', 'typo-repo'] },
  'suborg-c.yml': { suborgproperties: [{ suborg: 'c' }] },
  'suborg-glob.yml': { suborgrepos: ['repo-*'] },
  'suborg-team.yml': { suborgteams: ['my-team'] }
}

// Without suborg-glob, whose repo-* glob would claim every repo not resolved before it
const SUBORGS_WITHOUT_GLOB = Object.fromEntries(Object.entries(SUBORGS).filter(([name]) => name !== 'suborg-glob.yml'))

class HttpError extends Error {
  constructor (status, message) {
    super(message)
    this.status = status
  }
}

// Fills a URL template's {placeholders} from the request params, as Octokit does
function expand (url, params) {
  return url.replace(/{(\w+)}/g, (_, key) => params[key])
}

// A minimal stand-in for ProbotOctokit (which can't be loaded under Jest here). Every
// call goes through the request hooks and is routed to the fake org above.
// `withoutAdmin` lists repos the token lacks admin on; `permissions: false` leaves permissions out.
// Reading a repo in `forbiddenRepos` fails with a 403. `baseSuborgs` are the suborg files at the
// PR's base commit, the same as `suborgs` unless given; `suborgsByRef` gives them at other commits.
// `comparison` is the head...base comparison, or an HttpError to fail it with. By default the
// branch is up to date, so the merge base is the base commit.
function createFakeOctokitClass ({
  prFiles, suborgs, baseSuborgs = suborgs, suborgsByRef = {}, calls, pullRequest = {}, refs = [BRANCH, HEAD_SHA], settingsYml = SETTINGS_YML,
  contentRefs = new Set(), withoutAdmin = [], permissions = true, forbiddenRepos = [],
  comparison = { ahead_by: 0, files: [], merge_base_commit: { sha: BASE_SHA } },
  failOnce = []
}) {
  // Paths in `failOnce` fail with a 502 the first time they're requested, as a transient error would
  const failed = new Set()
  const suborgsAt = ref => suborgsByRef[ref] ?? (ref === BASE_SHA ? baseSuborgs : suborgs)
  const filesAt = ref => ({
    '.github/settings.yml': settingsYml,
    ...Object.fromEntries(Object.entries(suborgsAt(ref)).map(([name, data]) => [`.github/suborgs/${name}`, data]))
  })

  function respond (method, path, params) {
    const [pathname, query] = path.split('?')
    if (failOnce.includes(pathname) && !failed.has(pathname)) {
      failed.add(pathname)
      throw new HttpError(502, 'Bad Gateway')
    }
    let match
    if ((match = pathname.match(/^\/repos\/my-org\/admin\/pulls\/1$/))) {
      const repo = { full_name: `${ORG}/admin` }
      return { state: 'open', head: { ref: BRANCH, sha: HEAD_SHA, repo }, base: { ref: 'main', sha: BASE_SHA, repo }, ...pullRequest }
    }
    if (pathname === `/repos/my-org/admin/compare/${HEAD_SHA}...${BASE_SHA}`) {
      if (comparison instanceof Error) {
        throw comparison
      }
      return comparison
    }
    if ((match = pathname.match(/^\/repos\/my-org\/admin\/commits\/(.+)$/))) {
      if (!refs.includes(match[1])) {
        throw new HttpError(422, `No commit found for SHA: ${match[1]}`)
      }
      return { sha: HEAD_SHA }
    }
    if (pathname === '/repos/my-org/admin/pulls/1/files') {
      // A file is a name, or { filename, status } for a status such as 'removed'
      return prFiles.map(file => typeof file === 'string' ? { filename: file } : file)
    }
    if ((match = pathname.match(/^\/repos\/my-org\/admin\/contents\/(.+)$/))) {
      const filePath = match[1]
      contentRefs.add(params.ref)
      const files = filesAt(params.ref)
      if (filePath === '.github') {
        return [{ name: 'settings.yml' }, { name: 'suborgs' }]
      }
      if (filePath === '.github/suborgs') {
        return Object.keys(suborgsAt(params.ref)).map(name => ({ name, path: `.github/suborgs/${name}` }))
      }
      if (!files[filePath]) {
        calls.push(`404 ${pathname}`)
        throw new HttpError(404, 'Not Found')
      }
      return { content: Buffer.from(yaml.dump(files[filePath])).toString('base64') }
    }
    if (pathname === '/orgs/my-org/rulesets') {
      return []
    }
    if (pathname === '/orgs/my-org/repos') {
      return REPOS.map(r => ({
        name: r.name,
        owner: { login: ORG },
        archived: !!r.archived,
        ...(permissions && { permissions: { admin: !withoutAdmin.includes(r.name), pull: true } })
      }))
    }
    if (pathname === '/orgs/my-org/properties/values') {
      const [, value] = decodeURIComponent(query.split('=')[1]).match(/^props\.suborg:(.*)$/)
      return REPOS.filter(r => r.suborg === value).map(r => ({ repository_name: r.name }))
    }
    if (pathname === '/orgs/my-org/teams/my-team/repos') {
      return [{ name: 'repo-team' }]
    }
    if ((match = pathname.match(/^\/repos\/my-org\/([^/]+)$/))) {
      const repo = REPOS.find(r => r.name === match[1])
      if (forbiddenRepos.includes(match[1])) {
        throw new HttpError(403, `Forbidden ${match[1]}`)
      }
      if (!repo) {
        throw new HttpError(404, 'Not Found')
      }
      return { name: repo.name, archived: !!repo.archived }
    }
    if (pathname.match(/^\/repos\/my-org\/[^/]+\/labels$/)) {
      return []
    }
    throw new HttpError(404, `No fake response for ${method} ${path}`)
  }

  return class FakeOctokit {
    constructor () {
      const wraps = []
      this.hook = { wrap: (name, fn) => wraps.push(fn) }
      this.send = async (method, url, params = {}) => {
        const request = async () => {
          const path = expand(url, params)
          calls.push(`${method} ${path}`)
          return { data: respond(method, path, params), headers: {} }
        }
        // Each wrap hook gets the request it wraps, as with Octokit
        const wrapped = wraps.reduce((inner, fn) => options => fn(inner, options), request)
        return wrapped({ method, url, ...params })
      }
      const route = (method, url) => {
        const fn = params => this.send(method, url, params)
        fn.endpoint = params => ({ method, url: expand(url, params), body: params })
        fn.endpoint.merge = params => ({ method, url, ...params })
        return fn
      }
      this.rest = {
        pulls: {
          get: route('GET', '/repos/{owner}/{repo}/pulls/{pull_number}'),
          listFiles: route('GET', '/repos/{owner}/{repo}/pulls/{pull_number}/files')
        },
        repos: {
          get: route('GET', '/repos/{owner}/{repo}'),
          getCommit: route('GET', '/repos/{owner}/{repo}/commits/{ref}'),
          getContent: route('GET', '/repos/{owner}/{repo}/contents/{path}')
        },
        git: { getTree: route('GET', '/repos/{owner}/{repo}/git/trees/{tree_sha}') },
        issues: {
          listLabelsForRepo: route('GET', '/repos/{owner}/{repo}/labels'),
          createLabel: route('POST', '/repos/{owner}/{repo}/labels'),
          updateLabel: route('PATCH', '/repos/{owner}/{repo}/labels/{name}'),
          deleteLabel: route('DELETE', '/repos/{owner}/{repo}/labels/{name}')
        },
        teams: { listReposInOrg: route('GET', '/orgs/{org}/teams/{team_slug}/repos') }
      }
      this.request = (r, params) => {
        const [method, url] = r.split(' ')
        return this.send(method, url, params)
      }
      this.request.endpoint = url => ({ method: 'GET', url })
      this.request.endpoint.merge = (r, params) => {
        const [method, url] = r.split(' ')
        return { method, url, ...params }
      }
    }

    async paginate (routeOrOptions, params) {
      if (typeof routeOrOptions === 'function') {
        return (await routeOrOptions(params)).data
      }
      if (typeof routeOrOptions === 'string') {
        return (await this.request(routeOrOptions, params)).data
      }
      const { method, url, ...rest } = routeOrOptions
      return (await this.send(method, url, rest)).data
    }
  }
}

const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child () { return this } }

// With `isolated`, runs with a fresh copy of the dry run and Safe Settings' modules, so that
// lib/env and lib/deploymentConfig load again and pick up --admin-repo or --deployment-config.
async function dryRun (args, { prFiles, suborgs = SUBORGS, baseSuborgs, suborgsByRef, comparison, failOnce, pullRequest, refs, settingsYml, withoutAdmin, permissions, forbiddenRepos, isolated = false } = {}) {
  const calls = []
  const contentRefs = new Set()
  const Octokit = createFakeOctokitClass({ prFiles, suborgs, baseSuborgs, suborgsByRef, comparison, failOnce, calls, pullRequest, refs, settingsYml, contentRefs, withoutAdmin, permissions, forbiddenRepos })
  const options = parseCliArgs(['--org', ORG, '--pr', '1', ...args])
  const runOptions = { token: 'fake', Octokit, log: silentLog }
  let running
  if (isolated) {
    // run() loads Safe Settings' modules before its first await, so inside the isolated registry
    jest.isolateModules(() => { running = require('../../local-dry-run').run(options, runOptions) })
  } else {
    running = run(options, runOptions)
  }
  return { report: await running, calls, contentRefs }
}

// Repos that had settings evaluated (the fake org has no labels, so every evaluated repo
// gets a Labels result)
function evaluatedRepos (report) {
  return [...new Set(report.results.filter(r => r.plugin === 'Labels').map(r => r.repo))].sort()
}

// The requests the fake received, leaving out its "404 ..." notes on content reads
function requestsSent (calls) {
  return calls.filter(c => !c.startsWith('404 ')).length
}

function errorMessages (report) {
  return [
    ...report.results.filter(r => r.type === 'ERROR').map(r => r.action.msg),
    ...report.errors.map(e => e.msg)
  ]
}

function membership (report, suborgFile) {
  return report.suborgMembership.find(s => s.path === `.github/suborgs/${suborgFile}`)
}

beforeEach(() => {
  Settings.fileCache = {}
})

describe('parseCliArgs', () => {
  it('requires --org and --pr', () => {
    expect(() => parseCliArgs(['--pr', '1'])).toThrow('--org')
    expect(() => parseCliArgs(['--org', ORG])).toThrow('--pr')
  })

  it('rejects a --pr that is not a positive integer', () => {
    expect(() => parseCliArgs(['--org', ORG, '--pr', 'abc'])).toThrow('positive integer')
  })

  it('requires --assume-suborg and --assume-repos together', () => {
    expect(() => parseCliArgs(['--org', ORG, '--pr', '1', '--assume-suborg', 'suborg-a'])).toThrow('used together')
    expect(() => parseCliArgs(['--org', ORG, '--pr', '1', '--assume-repos', 'repo-b'])).toThrow('used together')
  })

  it('splits comma-separated lists', () => {
    const options = parseCliArgs(['--org', ORG, '--pr', '1', '--repos', 'repo-a1, repo-b,', '--assume-suborg', 'suborg-a', '--assume-repos', 'repo-b'])
    expect(options.repos).toEqual(['repo-a1', 'repo-b'])
    expect(options.assumeRepos).toEqual(['repo-b'])
  })
})

describe('withDefaultRestrictedRepos', () => {
  const DEFAULT = ['admin', '.github', 'safe-settings']

  // lib/deploymentConfig loads an empty file as {}, and an empty restrictedRepos: key as null
  it.each([
    ['an empty file', {}],
    ['a file without restrictedRepos', { configvalidators: [] }],
    ['an empty restrictedRepos', { restrictedRepos: null }]
  ])('keeps the default restrictedRepos for %s', (_label, config) => {
    expect(withDefaultRestrictedRepos(config).restrictedRepos).toEqual(DEFAULT)
  })

  it("uses the file's restrictedRepos when it sets them, including an empty list", () => {
    expect(withDefaultRestrictedRepos({ restrictedRepos: { include: ['repo-a1'] } }).restrictedRepos).toEqual({ include: ['repo-a1'] })
    expect(withDefaultRestrictedRepos({ restrictedRepos: [] }).restrictedRepos).toEqual([])
  })
})

describe('getChangedConfigs', () => {
  it('maps changed files to repo and suborg changes', () => {
    const files = ['.github/settings.yml', '.github/repos/repo-a1.yml', '.github/suborgs/suborg-a.yml', 'README.md']
    expect(getChangedConfigs(Settings, files, ORG)).toEqual({
      repoChanges: [{ repo: 'repo-a1', owner: ORG }],
      subOrgChanges: [{ name: 'suborg-a', path: '.github/suborgs/suborg-a.yml' }]
    })
  })
})

describe('createOctokit', () => {
  it('blocks any request that is not a GET', async () => {
    const calls = []
    const Octokit = createFakeOctokitClass({ prFiles: [], suborgs: {}, calls })
    const { octokit } = createOctokit(Octokit, 'fake', silentLog)

    await expect(octokit.rest.issues.createLabel({ owner: ORG, repo: 'repo-a1', name: 'x' }))
      .rejects.toThrow('Dry run blocked a write request: POST')
    expect(calls).toEqual([])
  })
})

describe('createLogger', () => {
  function logged (level, message) {
    const lines = []
    createLogger(level, (...args) => lines.push(args.join(' '))).error(message)
    return lines
  }

  it('logs a planned default branch rename as info, not an error', () => {
    const message = 'Branch new-main does not exist. So renaming the current default branch main to new-main'

    expect(logged('warn', message)).toEqual([])
    expect(logged('info', message)).toEqual([`[info] ${message}`])
  })

  it('logs other errors as errors', () => {
    expect(logged('warn', 'Something failed')).toEqual(['[error] Something failed'])
  })
})

describe('run', () => {
  it('evaluates the members of a changed suborg and never writes', async () => {
    const { report, calls } = await dryRun([], { prFiles: ['.github/suborgs/suborg-a.yml'] })

    expect(report.mode).toBe('selected')
    expect(errorMessages(report)).toEqual([])
    // repo-archived is a member but is skipped because it's archived
    expect(evaluatedRepos(report)).toEqual(['repo-a1', 'repo-a2'])
    expect(calls.filter(c => !c.startsWith('GET '))).toEqual([])
    expect(report.apiRequests).toBe(requestsSent(calls))
  })

  it('skips org rulesets with --skip-org-settings', async () => {
    const settingsYml = { ...SETTINGS_YML, rulesets: [{ name: 'org-ruleset', target: 'branch', enforcement: 'active' }] }
    const prFiles = ['.github/suborgs/suborg-a.yml']
    const withOrg = await dryRun([], { prFiles, settingsYml })
    const withoutOrg = await dryRun(['--skip-org-settings'], { prFiles, settingsYml })

    expect(withOrg.calls).toContain('GET /orgs/my-org/rulesets')
    expect(withoutOrg.calls.filter(c => c.includes('/orgs/my-org/rulesets'))).toEqual([])
    expect(withoutOrg.report.skippedOrgSettings).toBe(true)
    expect(evaluatedRepos(withoutOrg.report)).toEqual(['repo-a1', 'repo-a2'])
    expect(formatReport(withoutOrg.report)).toContain('Org-level settings (org rulesets) were skipped')
  })

  it('reads an open PR\'s config at its head commit', async () => {
    const { report, contentRefs } = await dryRun([], { prFiles: ['.github/suborgs/suborg-a.yml'] })

    expect(report.ref).toBe(BRANCH)
    expect(report.sha).toBe(HEAD_SHA)
    // The base commit is only read to find repos leaving a changed suborg; never the branch
    expect([...contentRefs].sort()).toEqual([BASE_SHA, HEAD_SHA].sort())
  })

  it('reads only the head commit when no suborg changes', async () => {
    const { contentRefs } = await dryRun([], { prFiles: ['.github/repos/repo-a1.yml'] })

    expect([...contentRefs]).toEqual([HEAD_SHA])
  })

  describe('when the branch is behind its base branch', () => {
    const prFiles = ['.github/suborgs/suborg-a.yml']
    const behind = (files, aheadBy = 2) => ({ ahead_by: aheadBy, files: files.map(filename => ({ filename })), merge_base_commit: { sha: MERGE_BASE_SHA } })

    it('says nothing when it is up to date', async () => {
      const { report } = await dryRun([], { prFiles })

      expect(report.baseComparison).toEqual({ base: 'main', aheadBy: 0, mergeBase: BASE_SHA, configFilesChanged: [], allFilesListed: true })
      expect(formatReport(report)).not.toContain('behind main')
    })

    it('warns when the base branch has changed config files since', async () => {
      const { report } = await dryRun([], { prFiles, comparison: behind(['.github/suborgs/suborg-c.yml', 'README.md']) })

      expect(report.baseComparison).toEqual(expect.objectContaining({ aheadBy: 2, mergeBase: MERGE_BASE_SHA, configFilesChanged: ['.github/suborgs/suborg-c.yml'] }))
      expect(formatReport(report)).toContain('Warning: the branch is 2 commit(s) behind main, and those commits change config files: .github/suborgs/suborg-c.yml.')
    })

    it('only notes it when those commits change no config', async () => {
      const { report } = await dryRun([], { prFiles, comparison: behind(['README.md']) })

      const text = formatReport(report)
      expect(text).toContain('Note: the branch is 2 commit(s) behind main. None of those commits change config files.')
      expect(text).not.toContain('Warning: the branch')
    })

    it('warns when GitHub lists too many files to tell', async () => {
      const files = Array.from({ length: 300 }, (_, i) => `docs/page-${i}.md`)
      const { report } = await dryRun([], { prFiles, comparison: behind(files, 400) })

      expect(report.baseComparison.allFilesListed).toBe(false)
      expect(formatReport(report)).toContain('change more files than GitHub lists, so config files may be among them')
    })

    it('carries on, with a note, when the comparison fails', async () => {
      const { report } = await dryRun([], { prFiles, comparison: new HttpError(404, 'Not Found') })

      expect(report.baseComparison).toEqual({ base: 'main', error: '404 Not Found' })
      expect(evaluatedRepos(report)).toEqual(['repo-a1', 'repo-a2'])
      expect(formatReport(report)).toContain('Note: couldn\'t check whether the branch is behind main (404 Not Found).')
    })

    it('finds leaving repos from the commit the branch was made from', async () => {
      // Since the branch was made, main added repo-none to suborg-b, which the PR also edits.
      // repo-none isn't in the branch's suborg-b, but merging keeps it there, so it isn't leaving.
      const suborgs = SUBORGS_WITHOUT_GLOB
      const onMain = { ...suborgs, 'suborg-b.yml': { suborgrepos: ['repo-b', 'repo-none'] } }
      const { report, contentRefs } = await dryRun([], {
        prFiles: ['.github/suborgs/suborg-b.yml'],
        suborgs,
        baseSuborgs: onMain,
        suborgsByRef: { [MERGE_BASE_SHA]: suborgs },
        comparison: behind(['.github/suborgs/suborg-b.yml'], 1)
      })

      expect(report.leavingRepos).toEqual([])
      expect(contentRefs).toContain(MERGE_BASE_SHA)
      expect(contentRefs).not.toContain(BASE_SHA)
    })
  })

  describe('repos leaving a changed suborg', () => {
    const suborgs = SUBORGS_WITHOUT_GLOB
    const baseSuborgs = { ...suborgs, 'suborg-b.yml': { suborgrepos: ['repo-b', 'repo-none'] } }
    const leavingResults = report => report.results.filter(r => r.repo === 'repo-none')

    it('evaluates them after the members, as changes that apply at their next sync', async () => {
      const { report } = await dryRun([], { prFiles: ['.github/suborgs/suborg-b.yml'], suborgs, baseSuborgs })

      expect(report.leavingRepos).toEqual([
        { repo: 'repo-none', from: '.github/suborgs/suborg-b.yml', to: null, evaluated: true, appliesOnMerge: false }
      ])
      expect(membership(report, 'suborg-b.yml').leaving).toEqual([{ repo: 'repo-none', to: null }])
      expect(evaluatedRepos(report)).toEqual(['repo-b', 'repo-none'])
      expect(leavingResults(report).length).toBeGreaterThan(0)
      expect(leavingResults(report).every(r => r.deferred)).toBe(true)
      expect(report.results.filter(r => r.repo === 'repo-b').some(r => r.deferred)).toBe(false)

      const text = formatReport(report)
      expect(text).toContain('leaving with this PR: repo-none (no suborg)')
      expect(text).toContain('Repos not covered by this PR: repo-none (leaving a changed suborg)')
      expect(report.nextSyncRepos).toEqual([{ repo: 'repo-none', reason: 'leaving' }])
      expect(text).toContain('These changes apply the next time it')
    })

    it('says where a leaving repo goes when another suborg picks it up', async () => {
      const withGlob = { ...SUBORGS, 'suborg-b.yml': { suborgrepos: ['repo-b'] } }
      const { report } = await dryRun([], { prFiles: ['.github/suborgs/suborg-b.yml'], suborgs: withGlob, baseSuborgs: { ...withGlob, 'suborg-b.yml': baseSuborgs['suborg-b.yml'] } })

      expect(report.leavingRepos).toEqual([
        expect.objectContaining({ repo: 'repo-none', to: '.github/suborgs/suborg-glob.yml' })
      ])
    })

    it('treats the members of a deleted suborg file as leaving', async () => {
      const withoutB = Object.fromEntries(Object.entries(suborgs).filter(([name]) => name !== 'suborg-b.yml'))
      const prFiles = [{ filename: '.github/suborgs/suborg-b.yml', status: 'removed' }]
      const { report, calls } = await dryRun([], { prFiles, suborgs: withoutB, baseSuborgs: suborgs })

      expect(membership(report, 'suborg-b.yml')).toEqual(expect.objectContaining({ deleted: true, leaving: [{ repo: 'repo-b', to: null }] }))
      expect(evaluatedRepos(report)).toEqual(['repo-b'])
      expect(report.results.filter(r => r.repo === 'repo-b').every(r => r.deferred)).toBe(true)
      // The deleted file isn't read at the head commit, where it would be a 404 logged as an error
      expect(calls.filter(c => c.startsWith('404 '))).toEqual([])
    })

    it('on a full sync with --only-changed, evaluates them as applying on merge', async () => {
      const { report } = await dryRun(['--only-changed'], { prFiles: ['.github/settings.yml', '.github/suborgs/suborg-b.yml'], suborgs, baseSuborgs })

      expect(report.leavingRepos).toEqual([expect.objectContaining({ repo: 'repo-none', evaluated: true, appliesOnMerge: true })])
      expect(evaluatedRepos(report)).toEqual(['repo-b', 'repo-none'])
      expect(report.results.some(r => r.deferred)).toBe(false)
    })

    it('reports an error, rather than none leaving, when membership at the head fails once', async () => {
      // The first custom property lookup is the head membership check's; the run's own succeeds
      const { report } = await dryRun([], { prFiles: ['.github/suborgs/suborg-a.yml'], suborgs, failOnce: ['/orgs/my-org/properties/values'] })

      expect(report.leavingRepos).toEqual([])
      expect(errorMessages(report)).toEqual([
        expect.stringMatching(/^Couldn't work out which repos leave the changed suborgs: suborg membership at the head commit couldn't be resolved: .*Bad Gateway/)
      ])
      expect(evaluatedRepos(report)).toEqual(['repo-a1', 'repo-a2'])
    })

    it('labels an error about the whole run as the run\'s, not a repo\'s', async () => {
      // The changed repo file makes the run point settings.repo at repo-b before the error
      const prFiles = ['.github/repos/repo-b.yml', '.github/suborgs/suborg-a.yml']
      const { report } = await dryRun([], { prFiles, suborgs, failOnce: ['/orgs/my-org/properties/values'] })

      expect(report.errors).toEqual([expect.objectContaining({ plugin: 'dry run', repo: null })])
      expect(formatReport(report)).toContain('  dry run: Couldn\'t work out which repos leave')
    })

    it('reports none when the members are unchanged', async () => {
      const { report } = await dryRun([], { prFiles: ['.github/suborgs/suborg-b.yml'], suborgs })

      expect(report.leavingRepos).toEqual([])
      expect(report.results.some(r => r.deferred)).toBe(false)
    })
  })

  it.each([
    ['merged', { state: 'closed', merged_at: '2026-01-01T00:00:00Z' }],
    ['closed', { state: 'closed', merged_at: null }]
  ])('refuses a %s PR', async (label, pullRequest) => {
    await expect(dryRun([], { prFiles: ['.github/suborgs/suborg-a.yml'], pullRequest }))
      .rejects.toThrow(`PR #1 is ${label}. The dry run only checks open PRs.`)
  })

  describe('--admin-repo', () => {
    // run() sets process.env.ADMIN_REPO, so put back whatever was there
    const previous = process.env.ADMIN_REPO
    afterEach(() => {
      if (previous === undefined) {
        delete process.env.ADMIN_REPO
      } else {
        process.env.ADMIN_REPO = previous
      }
    })

    it('refuses an --admin-repo that comes too late to take effect', async () => {
    // lib/env was loaded with the default when this file required lib/settings
      await expect(dryRun(['--admin-repo', 'other-admin'], { prFiles: [] }))
        .rejects.toThrow('--admin-repo other-admin can\'t take effect: lib/env was already loaded with ADMIN_REPO=admin')
    })

    it('accepts an --admin-repo that matches the loaded one', async () => {
      const { report } = await dryRun(['--admin-repo', 'admin'], { prFiles: ['.github/suborgs/suborg-a.yml'] })

      expect(report.mode).toBe('selected')
    })
  })

  describe('--deployment-config', () => {
    const fs = require('fs')
    const os = require('os')
    const path = require('path')
    // run() sets process.env.DEPLOYMENT_CONFIG_FILE, so put back whatever was there
    const previous = process.env.DEPLOYMENT_CONFIG_FILE
    let dir

    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-config-')) })
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true })
      if (previous === undefined) {
        delete process.env.DEPLOYMENT_CONFIG_FILE
      } else {
        process.env.DEPLOYMENT_CONFIG_FILE = previous
      }
    })

    function writeDeploymentConfig (config) {
      const file = path.join(dir, 'deployment-settings.yml')
      fs.writeFileSync(file, yaml.dump(config))
      return file
    }

    // A validator for topics, inside the repository section. Only the merges inside Safe Settings
    // check validators below a section, so this shows they got the file.
    const noTopics = { configvalidators: [{ plugin: 'topics', error: 'Topics are not allowed', script: 'return false' }] }
    const settingsYml = { ...SETTINGS_YML, repository: { topics: ['org-topic'] } }
    const suborgs = { ...SUBORGS_WITHOUT_GLOB, 'suborg-a.yml': { suborgproperties: [{ suborg: 'a' }], repository: { topics: ['suborg-topic'] } } }
    const prFiles = ['.github/suborgs/suborg-a.yml']

    it('applies its validators to the merges inside Safe Settings', async () => {
      const file = writeDeploymentConfig(noTopics)
      const { report } = await dryRun(['--deployment-config', file], { prFiles, suborgs, settingsYml, isolated: true })

      expect(errorMessages(report)).toEqual(expect.arrayContaining([expect.stringContaining('Topics are not allowed')]))
    })

    it('runs no such validator without it', async () => {
      const { report } = await dryRun([], { prFiles, suborgs, settingsYml, isolated: true })

      expect(errorMessages(report).filter(m => m.includes('Topics are not allowed'))).toEqual([])
    })

    it('refuses a file that does not exist', async () => {
      await expect(dryRun(['--deployment-config', path.join(dir, 'missing.yml')], { prFiles, isolated: true }))
        .rejects.toThrow('--deployment-config: ')
    })

    it('refuses a --deployment-config that comes too late to take effect', async () => {
      // lib/env was loaded without it when this file required lib/settings
      const file = writeDeploymentConfig(noTopics)
      await expect(dryRun(['--deployment-config', file], { prFiles }))
        .rejects.toThrow('--deployment-config ' + file + ' can\'t take effect')
    })
  })

  it('stops with a clear error when the ref can\'t be read', async () => {
    await expect(dryRun([], { prFiles: ['.github/suborgs/suborg-a.yml'], refs: [] }))
      .rejects.toThrow(`Couldn't read ${BRANCH} (${HEAD_SHA}) in ${ORG}/admin (422). Check the branch still exists`)
  })

  it('reports suborg membership and how each repo matched', async () => {
    const { report } = await dryRun([], { prFiles: ['.github/suborgs/suborg-a.yml', '.github/suborgs/suborg-team.yml'], suborgs: SUBORGS_WITHOUT_GLOB })

    expect(membership(report, 'suborg-a.yml').members).toEqual([
      { repo: 'repo-a1', via: ['custom property'], archived: false, resolvesTo: '.github/suborgs/suborg-a.yml' },
      { repo: 'repo-a2', via: ['custom property'], archived: false, resolvesTo: '.github/suborgs/suborg-a.yml' },
      { repo: 'repo-archived', via: ['custom property'], archived: true, resolvesTo: '.github/suborgs/suborg-a.yml' }
    ])
    expect(membership(report, 'suborg-team.yml').members).toEqual([
      { repo: 'repo-team', via: ['team my-team'], archived: false, resolvesTo: '.github/suborgs/suborg-team.yml' }
    ])
  })

  it('reports suborgrepos entries that match no repo, and repos that resolve to another suborg', async () => {
    const { report } = await dryRun([], { prFiles: ['.github/suborgs/suborg-b.yml', '.github/suborgs/suborg-glob.yml'] })

    expect(membership(report, 'suborg-b.yml').unmatchedPatterns).toEqual(['typo-repo'])
    // repo-b is listed by name in suborg-b, which is resolved before suborg-glob's glob
    const repoB = membership(report, 'suborg-glob.yml').members.find(m => m.repo === 'repo-b')
    expect(repoB).toEqual({ repo: 'repo-b', via: ['suborgrepos repo-*'], archived: false, resolvesTo: '.github/suborgs/suborg-b.yml' })
    expect(formatReport(report)).toContain('but goes to .github/suborgs/suborg-b.yml, which matched first')
    expect(formatReport(report)).toContain('suborgrepos entries that match no repo: typo-repo')
  })

  describe('--repos on a PR that changes repo or suborg files', () => {
    const suborgs = SUBORGS_WITHOUT_GLOB
    const prFiles = ['.github/suborgs/suborg-a.yml']

    it('adds the listed repos to those the PR covers', async () => {
      const { report } = await dryRun(['--repos', 'repo-a1,repo-b'], { prFiles, suborgs })

      expect(evaluatedRepos(report)).toEqual(['repo-a1', 'repo-a2', 'repo-b'])
    })

    it('marks listed repos the PR does not cover as changes at their next sync', async () => {
      const { report } = await dryRun(['--repos', 'repo-a1,repo-b'], { prFiles, suborgs })

      expect(report.nextSyncRepos).toEqual([{ repo: 'repo-b', reason: 'listed' }])
      expect(report.results.filter(r => r.repo === 'repo-b').every(r => r.deferred)).toBe(true)
      expect(report.results.filter(r => r.repo === 'repo-a1').some(r => r.deferred)).toBe(false)
      expect(formatReport(report)).toContain('Repos not covered by this PR: repo-b (from --repos)')
    })

    it('skips archived listed repos', async () => {
      const { report } = await dryRun(['--repos', 'repo-archived'], { prFiles: ['.github/suborgs/suborg-b.yml'], suborgs })

      expect(report.nextSyncRepos).toEqual([])
    })
  })

  it('rejects --repos that are not in the org, rather than reporting no changes', async () => {
    await expect(dryRun(['--repos', 'repo-a1,repo-typo'], { prFiles: ['.github/suborgs/suborg-a.yml'] }))
      .rejects.toThrow('--repos: not found in my-org: repo-typo')
  })

  it('suggests the right spelling when a --repos name differs only in case', async () => {
    await expect(dryRun(['--repos', 'Repo-A1'], { prFiles: ['.github/suborgs/suborg-a.yml'] }))
      .rejects.toThrow('--repos: not found in my-org: Repo-A1 (did you mean repo-a1?)')
  })

  it('reports every repo whose settings could not be read, under that repo', async () => {
    // A full sync, where the base class would put these errors under the admin repo
    const { report, calls } = await dryRun([], { prFiles: ['.github/settings.yml'], suborgs: SUBORGS_WITHOUT_GLOB, forbiddenRepos: ['repo-a1', 'repo-b'] })

    // The failed requests are counted too
    expect(report.apiRequests).toBe(requestsSent(calls))
    const errors = report.results.filter(r => r.type === 'ERROR').map(r => ({ plugin: r.plugin, repo: r.repo, msg: r.action.msg }))
    expect(errors).toEqual(expect.arrayContaining([
      { plugin: 'Settings', repo: 'repo-a1', msg: 'Error: Forbidden repo-a1' },
      { plugin: 'Settings', repo: 'repo-b', msg: 'Error: Forbidden repo-b' }
    ]))
    expect(errors.filter(e => e.plugin === 'LocalSettings' || e.repo === 'admin')).toEqual([])
    expect(evaluatedRepos(report)).not.toContain('repo-a1')
    expect(formatReport(report)).toContain('Settings / repo-b: Error: Forbidden repo-b')
  })

  describe('admin access', () => {
    it('flags evaluated repos the token lacks admin on', async () => {
      // repo-b is outside the changed suborg, and repo-archived is skipped, so neither is flagged
      const { report } = await dryRun([], { prFiles: ['.github/suborgs/suborg-a.yml'], withoutAdmin: ['repo-a2', 'repo-b', 'repo-archived'] })

      expect(report.reposWithoutAdmin).toEqual(['repo-a2'])
      expect(report.reposAdminUnknown).toEqual([])
      expect(formatReport(report)).toContain('results for these repos are unreliable')
      expect(formatReport(report)).toContain('  repo-a2\n')
    })

    it('says so when GitHub returns no permissions', async () => {
      const { report } = await dryRun([], { prFiles: ['.github/suborgs/suborg-a.yml'], permissions: false })

      expect(report.reposWithoutAdmin).toEqual([])
      expect(report.reposAdminUnknown).toEqual(['repo-a1', 'repo-a2'])
      expect(formatReport(report)).toContain('GitHub didn\'t say whether the token has admin')
    })

    it('adds nothing when the token has admin on every evaluated repo', async () => {
      const { report } = await dryRun([], { prFiles: ['.github/suborgs/suborg-a.yml'] })

      expect(report.reposWithoutAdmin).toEqual([])
      expect(report.reposAdminUnknown).toEqual([])
      expect(formatReport(report)).not.toContain('admin on')
    })

    it('makes no extra requests when no repo is evaluated', async () => {
      const { report, calls } = await dryRun([], { prFiles: ['README.md'], withoutAdmin: ['repo-a1'] })

      expect(report.mode).toBe('none')
      expect(report.reposWithoutAdmin).toEqual([])
      expect(calls).not.toContain('GET /orgs/my-org/repos')
    })
  })

  describe('--assume-suborg and --assume-repos', () => {
    it('moves repos into a suborg as if their custom property had changed', async () => {
      const { report } = await dryRun(['--assume-suborg', 'suborg-a', '--assume-repos', 'repo-c1'], { prFiles: ['.github/suborgs/suborg-c.yml'] })

      expect(errorMessages(report)).toEqual([])
      expect(membership(report, 'suborg-a.yml').members.find(m => m.repo === 'repo-c1'))
        .toEqual({ repo: 'repo-c1', via: ['assumed (--assume-repos)'], archived: false, resolvesTo: '.github/suborgs/suborg-a.yml' })
      // repo-c1 has left suborg-c, the suborg its live property still points at
      expect(membership(report, 'suborg-c.yml').members).toEqual([])
      // The assumed repo is evaluated even though suborg-a.yml isn't changed by the PR
      expect(evaluatedRepos(report)).toContain('repo-c1')
    })

    it('evaluates assumed repos alongside --repos', async () => {
      const { report } = await dryRun(['--repos', 'repo-b', '--assume-suborg', 'suborg-a', '--assume-repos', 'repo-c1'], { prFiles: ['.github/suborgs/suborg-a.yml'], suborgs: SUBORGS_WITHOUT_GLOB })

      expect(evaluatedRepos(report)).toEqual(['repo-a1', 'repo-a2', 'repo-b', 'repo-c1'])
    })

    it('still evaluates org-level settings when a full sync stops on a conflict', async () => {
      const settingsYml = { ...SETTINGS_YML, rulesets: [{ name: 'org-ruleset', target: 'branch', enforcement: 'active' }] }
      const { report } = await dryRun(['--assume-suborg', 'suborg-a', '--assume-repos', 'repo-b'], { prFiles: ['.github/settings.yml'], settingsYml })

      expect(errorMessages(report)).toEqual(expect.arrayContaining([expect.stringContaining('Multiple suborg configs for repo-b')]))
      expect(report.results.filter(r => r.scope === 'org' && r.type !== 'ERROR').length).toBeGreaterThan(0)
      expect(evaluatedRepos(report)).toEqual([])
    })

    it('reports a conflict with a suborg that lists the repo by name, and stops', async () => {
      const { report, calls } = await dryRun(['--assume-suborg', 'suborg-a', '--assume-repos', 'repo-b'], { prFiles: ['.github/suborgs/suborg-a.yml'] })

      const messages = errorMessages(report)
      expect(messages).toEqual(expect.arrayContaining([
        expect.stringContaining('Multiple suborg configs for repo-b'),
        expect.stringContaining('Stopped: suborg membership could not be resolved')
      ]))
      // Reported once, by the run, not again by the check for repos leaving a suborg
      expect(messages.filter(m => m.startsWith('Couldn\'t work out which repos leave'))).toEqual([])
      expect(evaluatedRepos(report)).toEqual([])
      // No membership summary after a failure, and no retries for every repo
      expect(report.suborgMembership).toEqual([])
      expect(calls.filter(c => c.endsWith('/labels'))).toEqual([])
    })

    it('rejects repos that are not in the org', async () => {
      await expect(dryRun(['--assume-suborg', 'suborg-a', '--assume-repos', 'no-such-repo'], { prFiles: [] }))
        .rejects.toThrow('--assume-repos: not found in my-org: no-such-repo')
    })

    it('rejects a suborg that does not exist', async () => {
      await expect(dryRun(['--assume-suborg', 'no-such-suborg', '--assume-repos', 'repo-b'], { prFiles: [] }))
        .rejects.toThrow('.github/suborgs/no-such-suborg.yml not found')
    })

    it('rejects a suborg without suborgproperties', async () => {
      await expect(dryRun(['--assume-suborg', 'suborg-b', '--assume-repos', 'repo-none'], { prFiles: [] }))
        .rejects.toThrow('has no suborgproperties')
    })
  })

  describe('when the PR changes the global settings file', () => {
    const prFiles = ['.github/settings.yml', '.github/suborgs/suborg-b.yml']
    const suborgs = SUBORGS_WITHOUT_GLOB

    it('evaluates every unarchived repo by default', async () => {
      const { report } = await dryRun(['--ignore-restricted-repos'], { prFiles, suborgs })

      expect(report.mode).toBe('full')
      expect(evaluatedRepos(report)).toEqual(['repo-a1', 'repo-a2', 'repo-b', 'repo-c1', 'repo-none', 'repo-team'])
    })

    it('with --only-changed, evaluates only the repos the PR covers plus --repos', async () => {
      const { report } = await dryRun(['--ignore-restricted-repos', '--only-changed', '--repos', 'repo-none'], { prFiles, suborgs })

      expect(report.onlyChanged).toBe(true)
      expect(evaluatedRepos(report)).toEqual(['repo-b', 'repo-none'])
      expect(formatReport(report)).toContain('Use --repos to check other repos.')
    })

    it('with --repos alone, still evaluates every repo, as applying on merge', async () => {
      const { report } = await dryRun(['--ignore-restricted-repos', '--repos', 'repo-a1'], { prFiles, suborgs })

      expect(evaluatedRepos(report)).toEqual(['repo-a1', 'repo-a2', 'repo-b', 'repo-c1', 'repo-none', 'repo-team'])
      expect(report.nextSyncRepos).toEqual([])
    })
  })
})

describe('formatReport', () => {
  const reportWith = (...results) => ({ pr: 1, ref: BRANCH, sha: HEAD_SHA, mode: 'selected', suborgMembership: [], results, errors: [] })

  it("leaves GitHub's own fields out of deleted rulesets", () => {
    const deleted = {
      id: 42,
      node_id: 'RRS_abc',
      name: 'old-ruleset',
      enforcement: 'active',
      source: `${ORG}/repo-a1`,
      source_type: 'Repository',
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-02T00:00:00Z',
      current_user_can_bypass: 'never',
      _links: { self: { href: 'https://api.github.com/x' } }
    }
    const text = formatReport(reportWith({
      type: 'INFO',
      plugin: 'Rulesets',
      repo: 'repo-a1',
      action: { additions: null, deletions: [deleted], modifications: null }
    }))

    expect(text).toContain('"name": "old-ruleset"')
    expect(text).toContain('"enforcement": "active"')
    for (const field of ['"id"', 'node_id', 'source', 'created_at', 'updated_at', 'current_user_can_bypass', '_links']) {
      expect(text).not.toContain(field)
    }
  })

  it('keeps those fields on rulesets that are added or modified, and on other plugins', () => {
    const text = formatReport(reportWith(
      { type: 'INFO', plugin: 'Rulesets', repo: 'repo-a1', action: { additions: [{ name: 'new', id: 7 }], deletions: {}, modifications: null } },
      { type: 'INFO', plugin: 'Environments', repo: 'repo-a1', action: { additions: null, deletions: [{ name: 'env', id: 8 }], modifications: null } }
    ))

    expect(text).toContain('"id": 7')
    expect(text).toContain('"id": 8')
    expect(text).not.toContain('deletions:\n    {}')
  })
})
