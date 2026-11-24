#!/usr/bin/env node
// Runs the Safe Settings pull request dry run (nop mode) locally, authenticated
// with a user token instead of the GitHub App. Because it lists repos through the
// org API rather than the app installation, it can also evaluate repos the app
// isn't installed on yet.
const { AsyncLocalStorage } = require('async_hooks')
const fs = require('fs')
const path = require('path')
const { parseArgs } = require('util')

const USAGE = `Usage: GITHUB_TOKEN=<token> node local-dry-run.js --org <org> --pr <number> [options]

Runs the Safe Settings dry run for a pull request on the admin repo, without
writing anything to GitHub.

Options:
  --org <org>                  Organization that owns the admin repo (required)
  --pr <number>                Pull request number on the admin repo (required)
  --admin-repo <name>          Admin repo name (default: ADMIN_REPO or "admin")
  --deployment-config <path>   Deployment config file (default: DEPLOYMENT_CONFIG_FILE or
                               deployment-settings.yml in the current directory, if it exists)
  --ignore-restricted-repos    Evaluate repos even if restrictedRepos would skip them
  --repos <a,b,...>            Also evaluate these repos. Those the PR doesn't cover are listed
                               separately, as changes at their next sync, unless the PR changes
                               the global settings file
  --only-changed               When the PR changes the global settings file, only evaluate
                               org-level settings and the repos covered by the PR's changed
                               repo and suborg files, plus any --repos and --assume-repos,
                               instead of every repo
  --skip-org-settings          Don't evaluate org-level settings (org rulesets). Use it if the
                               token can't read org rulesets, which needs organization owner
  --assume-suborg <file>       Suborg file name without .yml (e.g. my-suborg for
                               suborgs/my-suborg.yml), not a custom property value. With
                               --assume-repos, treat those repos as matching this suborg's
                               suborgproperties (and no other suborg's), as if their custom
                               property values had already been changed
  --assume-repos <a,b,...>     Repos to treat as members of --assume-suborg. They are always
                               evaluated
  --json                       Print the raw results as JSON
  -h, --help                   Show this help

Environment:
  GITHUB_TOKEN                 Token used for all API calls (required)
  LOG_LEVEL                    debug, info, warn or error (default: warn)
`

const LOG_LEVELS = ['debug', 'info', 'warn', 'error']

// Messages Safe Settings logs as errors that only describe what it would do. In a dry run
// nothing is done, so they are logged as info instead.
const PLANNED_CHANGE_MESSAGES = [
  /^Branch \S+ does not exist\. So renaming the current default branch/
]

function createLogger (level = 'warn', write = console.error) {
  const threshold = LOG_LEVELS.indexOf(level)
  const log = {}
  for (const [i, name] of LOG_LEVELS.entries()) {
    log[name] = i >= threshold ? (...args) => write(`[${name}]`, ...args) : () => {}
  }
  const logError = log.error
  log.error = (...args) => {
    if (typeof args[0] === 'string' && PLANNED_CHANGE_MESSAGES.some(pattern => pattern.test(args[0]))) {
      log.info(...args)
    } else {
      logError(...args)
    }
  }
  log.child = () => log
  return log
}

function splitList (value) {
  const items = (value || '').split(',').map(item => item.trim()).filter(Boolean)
  return items.length > 0 ? items : undefined
}

function parseCliArgs (argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      org: { type: 'string' },
      pr: { type: 'string' },
      'admin-repo': { type: 'string' },
      'deployment-config': { type: 'string' },
      'ignore-restricted-repos': { type: 'boolean', default: false },
      repos: { type: 'string' },
      'only-changed': { type: 'boolean', default: false },
      'skip-org-settings': { type: 'boolean', default: false },
      'assume-suborg': { type: 'string' },
      'assume-repos': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false }
    }
  })
  if (values.help) {
    return { help: true }
  }
  const missing = ['org', 'pr'].filter(name => !values[name])
  if (missing.length > 0) {
    throw new Error(`Missing required option(s): ${missing.map(m => `--${m}`).join(', ')}`)
  }
  const pr = Number(values.pr)
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new Error(`--pr must be a positive integer, got "${values.pr}"`)
  }
  const assumeRepos = splitList(values['assume-repos'])
  const hasAssumeSuborg = Boolean(values['assume-suborg'])
  const hasAssumeRepos = assumeRepos !== undefined
  if (hasAssumeSuborg !== hasAssumeRepos) {
    throw new Error('--assume-suborg and --assume-repos must be used together')
  }
  return {
    org: values.org,
    pr,
    adminRepo: values['admin-repo'],
    deploymentConfigPath: values['deployment-config'],
    ignoreRestrictedRepos: values['ignore-restricted-repos'],
    repos: splitList(values.repos),
    onlyChanged: values['only-changed'],
    skipOrgSettings: values['skip-org-settings'],
    assumeSuborg: values['assume-suborg'],
    assumeRepos,
    json: values.json
  }
}

const DEFAULT_RESTRICTED_REPOS = ['admin', '.github', 'safe-settings']

// The deployment config as lib/deploymentConfig loaded it, which is what the merges inside the
// plugins validate against. Unlike the app, a file without restrictedRepos gets the default:
// Settings.isRestricted() throws for every repo when restrictedRepos is missing or has no value.
function withDefaultRestrictedRepos (deploymentConfig) {
  const config = Object.assign({}, deploymentConfig)
  if (config.restrictedRepos == null) {
    config.restrictedRepos = DEFAULT_RESTRICTED_REPOS
  }
  return config
}

// Mirrors getChangedRepoConfigName() and getChangedSubOrgConfigName() in index.js.
function getChangedConfigs (Settings, files, owner) {
  const repoChanges = files
    .filter(file => Settings.REPO_PATTERN.test(file))
    .map(file => ({ repo: file.match(/([^/]+)\.yml$/)[1], owner }))
  const subOrgChanges = files
    .filter(file => Settings.SUB_ORG_PATTERN.test(file))
    .map(file => ({ name: file.match(/([^/]+)\.yml$/)[1], path: file }))
  return { repoChanges, subOrgChanges }
}

function createLocalSettingsClass (Settings, options) {
  // Shared by every instance, so the org's repos are only listed once per run
  let orgRepositories
  // The repo that updateRepos() is processing. Repos are processed concurrently, so this
  // follows each one through its awaits rather than being a property of the instance.
  const currentRepo = new AsyncLocalStorage()

  return class LocalSettings extends Settings {
    // Repos whose settings were read, filled in by updateRepos()
    evaluatedRepos = new Set()

    listOrgRepositories () {
      if (!orgRepositories) {
        orgRepositories = this.github.paginate('GET /orgs/{org}/repos', { org: options.org, per_page: 100 })
      }
      return orgRepositories
    }

    // The base class lists repos via the app installation, which needs an app token.
    async eachRepositoryRepos (github, log) {
      log.debug('Fetching repositories for org')
      const repositories = await this.listOrgRepositories()
      return Promise.all(repositories.map(repository => this.checkAndProcessRepo(repository.owner.login, repository.name)))
    }

    isRestricted (repoName) {
      if (options.ignoreRestrictedRepos) {
        return false
      }
      return super.isRestricted(repoName)
    }

    // In nop mode, getSubOrgConfigs() doesn't throw when it fails; it records an error result.
    // When a repo is claimed by two suborgs it returns undefined, and updateRepos() would run
    // the lookup again for every repo. When a suborg file can't be read or parsed, it returns
    // the suborgs read before that file, without the changed-suborg filter. Stop in both cases:
    // without full suborg membership every later result would be misleading.
    async getSubOrgConfigs () {
      const countErrors = () => this.results.filter(r => r.type === 'ERROR').length
      const errorsBefore = countErrors()
      const subOrgConfigs = await super.getSubOrgConfigs()
      if (subOrgConfigs === undefined || countErrors() > errorsBefore) {
        // For run() to tell that the run's own lookup failed
        this.membershipUnresolved = true
        throw new Error('Stopped: suborg membership could not be resolved (see the error before this one)')
      }
      return subOrgConfigs
    }

    // Simulates --assume-repos having their custom property values changed to match the
    // --assume-suborg suborg. Done at the property lookup so that getSubOrgConfigs()
    // resolves membership and conflicts exactly as it would after the change.
    async getSubOrgRepositories (subOrgProperties) {
      const repositories = await super.getSubOrgRepositories(subOrgProperties)
      if (!this.assumedMembership) {
        return repositories
      }
      const { repos, suborgProperties } = this.assumedMembership
      const kept = repositories.filter(r => !repos.includes(r.repository_name))
      if (JSON.stringify(subOrgProperties) === suborgProperties) {
        kept.push(...repos.map(name => ({ repository_name: name })))
      }
      return kept
    }

    async updateRepos (repo) {
      if (this.skipRepo?.(repo.repo)) {
        this.log.debug(`Skipping ${repo.repo}, not covered by the PR (--only-changed)`)
        return
      }
      // Note which repos have their settings read, for checkAdminAccess(). On a suborg change
      // every repo comes through here, and the base class skips those outside that suborg.
      this.subOrgConfigs = this.subOrgConfigs || await this.getSubOrgConfigs()
      if (!this.subOrgConfigMap || this.getSubOrgConfig(repo.repo)) {
        this.evaluatedRepos.add(repo.repo)
      }
      return currentRepo.run(repo.repo, () => super.updateRepos(repo))
    }

    // An error that escapes a repo's plugins (such as the Repository plugin or the archive
    // check failing) is recorded by the base class under its own class name and this.repo,
    // which is the admin repo or another repo, not the one that failed. Label it correctly.
    appendToResults (res) {
      const repoName = currentRepo.getStore()
      if (repoName && res) {
        for (const result of [res].flat(4)) {
          if (result?.type === 'ERROR' && result.plugin === this.constructor.name) {
            result.plugin = 'Settings'
            result.repo = repoName
          }
        }
      }
      return super.appendToResults(res)
    }

    // The base class records errors under its own class name and this.repo, which is the admin
    // repo or whichever repo the run last set. Label one with the repo being processed, if there
    // is one; otherwise it's about the run as a whole.
    logError (msg) {
      super.logError(msg)
      const error = this.errors[this.errors.length - 1]
      const repoName = currentRepo.getStore()
      error.plugin = repoName ? 'Settings' : 'dry run'
      error.repo = repoName ?? null
    }

    // Results are reported by the CLI instead of being posted to the pull request.
    async handleResults () {}
  }
}

function createOctokit (Octokit, token, log) {
  const octokit = new Octokit({ auth: { token }, log })
  let count = 0
  octokit.hook.wrap('request', (request, requestOptions) => {
    // Belt and braces: nop mode shouldn't write, but refuse any write that slips through.
    if (requestOptions.method !== 'GET') {
      throw new Error(`Dry run blocked a write request: ${requestOptions.method} ${requestOptions.url}`)
    }
    // Counted before it's sent, so failed requests (such as 404s and 304s) count too
    count++
    return request(requestOptions)
  })
  return { octokit, requestCount: () => count }
}

// Finds the repos that a changed suborg file had as members at baseSha (the commit the PR's
// branch was made from), but no longer has at its head: removed from suborgrepos or suborgteams, no longer matching
// suborgproperties, or the file was deleted. Custom property values are the live ones at both
// commits (with --assume-repos applied at the head only), so only the PR's own changes count.
// `after` is a LocalSettings at the head commit with its subOrgConfigs already resolved.
async function findLeavingRepos ({ LocalSettings, context, config, baseSha, after, changedSubOrgPaths }) {
  const before = new LocalSettings(true, context, context.repo(), config, baseSha)
  try {
    before.subOrgConfigs = await before.getSubOrgConfigs()
  } catch (error) {
    const cause = before.results.find(r => r.type === 'ERROR')?.action?.msg || error.message
    throw new Error(`suborg membership at the base commit couldn't be resolved: ${cause}`)
  }
  const leaving = []
  for (const repo of await after.listOrgRepositories()) {
    if (repo.archived) {
      continue
    }
    const from = before.getSubOrgConfig(repo.name)?.source
    const to = after.getSubOrgConfig(repo.name)?.source ?? null
    if (changedSubOrgPaths.has(from) && to !== from) {
      leaving.push({ repo: repo.name, from, to })
    }
  }
  return leaving.sort((a, b) => a.repo.localeCompare(b.repo))
}

// Lists the repos each suborg file matches and how, and where each one ends up once
// getSubOrgConfigs() has resolved conflicts. Takes a new LocalSettings instance,
// so it has no subOrgConfigMap and sees every suborg's repos, not only the changed ones.
async function describeSuborgMembership (resolver, suborgPaths, Glob, leavingRepos = [], removedFiles = new Set()) {
  resolver.subOrgConfigs = resolver.subOrgConfigs || await resolver.getSubOrgConfigs()
  const orgRepos = await resolver.listOrgRepositories()
  const archived = new Set(orgRepos.filter(r => r.archived).map(r => r.name))
  const assumed = new Set(resolver.assumedMembership?.repos || [])

  const descriptions = []
  for (const suborgPath of suborgPaths) {
    const leaving = leavingRepos.filter(l => l.from === suborgPath).map(({ repo, to }) => ({ repo, to }))
    // Don't read a file the PR deletes: loadYaml() logs the 404 as an error before handling it
    const data = removedFiles.has(suborgPath) ? null : await resolver.loadYaml(suborgPath)
    if (!data) {
      descriptions.push({ path: suborgPath, deleted: true, members: [], unmatchedPatterns: [], leaving })
      continue
    }
    const via = new Map()
    const add = (repo, reason) => via.set(repo, [...(via.get(repo) || []), reason])
    const unmatchedPatterns = []

    for (const pattern of data.suborgrepos || []) {
      const glob = new Glob(pattern)
      const matched = orgRepos.filter(r => glob.test(r.name))
      if (matched.length === 0) {
        unmatchedPatterns.push(pattern)
      }
      matched.forEach(r => add(r.name, r.name === pattern ? 'suborgrepos' : `suborgrepos ${pattern}`))
    }
    for (const team of data.suborgteams || []) {
      const repos = await resolver.getReposForTeam(team)
      repos.forEach(r => add(r.name, `team ${team}`))
    }
    if (data.suborgproperties) {
      const repos = await resolver.getSubOrgRepositories(data.suborgproperties)
      repos.forEach(r => add(r.repository_name, assumed.has(r.repository_name) ? 'assumed (--assume-repos)' : 'custom property'))
    }

    const members = [...via.keys()].sort().map(repo => ({
      repo,
      via: via.get(repo),
      archived: archived.has(repo),
      resolvesTo: resolver.getSubOrgConfig(repo)?.source ?? null
    }))
    descriptions.push({ path: suborgPath, members, unmatchedPatterns, leaving })
  }
  return descriptions
}

// Without admin on a repo, GitHub leaves some of its settings out of responses or refuses to
// return them, so plugins can report changes that aren't real. The org's repo list includes the
// token's permissions on each repo, so flag the evaluated repos it lacks admin on. Archived
// repos are skipped by the run, and repos not in the org fail with their own error.
async function checkAdminAccess (settings) {
  const access = { reposWithoutAdmin: [], reposAdminUnknown: [] }
  if (settings.evaluatedRepos.size === 0) {
    return access
  }
  const orgRepos = new Map((await settings.listOrgRepositories()).map(r => [r.name, r]))
  for (const name of [...settings.evaluatedRepos].sort()) {
    const repo = orgRepos.get(name)
    if (!repo || repo.archived) {
      continue
    }
    if (typeof repo.permissions?.admin !== 'boolean') {
      access.reposAdminUnknown.push(name)
    } else if (!repo.permissions.admin) {
      access.reposWithoutAdmin.push(name)
    }
  }
  return access
}

// The PR's branch may be behind its base branch. Its config then lacks the base branch's newer
// commits, and so do the results, as with the app's own PR check. Compares head...base, so
// ahead_by counts the base branch's commits that the head doesn't have, and files lists what
// they changed. GitHub lists at most 300 files.
// Compares with the base branch by name: the PR's base.sha is the base branch as it was when the
// PR's branch was last pushed, so it misses commits made to the base branch since.
const MAX_COMPARE_FILES = 300
async function compareWithBase (octokit, context, pullRequest, configPath, log) {
  const base = pullRequest.base.ref
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}',
      context.repo({ basehead: `${pullRequest.head.sha}...${base}` }))
    const changedFiles = (data.files || []).map(f => f.filename)
    return {
      base,
      aheadBy: data.ahead_by,
      mergeBase: data.merge_base_commit.sha,
      configFilesChanged: changedFiles.filter(f => f.startsWith(`${configPath}/`)),
      allFilesListed: changedFiles.length < MAX_COMPARE_FILES
    }
  } catch (error) {
    log?.warn?.(`Couldn't compare the branch with ${base}: ${error.message}`)
    return { base, error: `${error.status || ''} ${error.message}`.trim() }
  }
}

// Repo names are matched exactly, so a name that differs only in case is reported with the
// right spelling.
async function assertReposInOrg (settings, optionName, repos, org) {
  const orgRepoNames = (await settings.listOrgRepositories()).map(r => r.name)
  const unknownRepos = repos.filter(repo => !orgRepoNames.includes(repo)).map(repo => {
    const match = orgRepoNames.find(name => name.toLowerCase() === repo.toLowerCase())
    return match ? `${repo} (did you mean ${match}?)` : repo
  })
  if (unknownRepos.length > 0) {
    throw new Error(`${optionName}: not found in ${org}: ${unknownRepos.join(', ')}`)
  }
}

async function run (options, { token, Octokit, log } = {}) {
  // lib/env reads process.env once, when it is first required, so set ADMIN_REPO and
  // DEPLOYMENT_CONFIG_FILE before loading lib/settings. lib/deploymentConfig then loads the
  // deployment config from DEPLOYMENT_CONFIG_FILE, for Settings and the plugins alike.
  if (options.adminRepo) {
    process.env.ADMIN_REPO = options.adminRepo
  }
  const deploymentConfigPath = options.deploymentConfigPath && path.resolve(options.deploymentConfigPath)
  if (deploymentConfigPath) {
    // lib/deploymentConfig silently falls back to its defaults when the file doesn't exist
    if (!fs.existsSync(deploymentConfigPath)) {
      throw new Error(`--deployment-config: ${options.deploymentConfigPath} not found`)
    }
    process.env.DEPLOYMENT_CONFIG_FILE = deploymentConfigPath
  }
  const Settings = require('./lib/settings')
  const ConfigManager = require('./lib/configManager')
  const Glob = require('./lib/glob')
  const DeploymentConfig = require('./lib/deploymentConfig')
  const { ADMIN_REPO: adminRepo, CONFIG_PATH, DEPLOYMENT_CONFIG_FILE_PATH } = require('./lib/env')
  // If something loaded lib/env earlier in this process, the settings above came too late
  const tooLate = (option, value, name, loaded) => new Error(`${option} ${value} can't take effect: lib/env was already loaded with ${name}=${loaded}. Set ${name} before loading Safe Settings, or run the CLI in its own process.`)
  if (options.adminRepo && options.adminRepo !== adminRepo) {
    throw tooLate('--admin-repo', options.adminRepo, 'ADMIN_REPO', adminRepo)
  }
  if (deploymentConfigPath && deploymentConfigPath !== DEPLOYMENT_CONFIG_FILE_PATH) {
    throw tooLate('--deployment-config', options.deploymentConfigPath, 'DEPLOYMENT_CONFIG_FILE', DEPLOYMENT_CONFIG_FILE_PATH)
  }

  const { octokit, requestCount } = createOctokit(Octokit || require('probot').ProbotOctokit, token, log)

  const context = {
    payload: { installation: { id: 0 } },
    octokit,
    log,
    repo: (params) => Object.assign({ owner: options.org, repo: adminRepo }, params)
  }

  const { data: pullRequest } = await octokit.rest.pulls.get(context.repo({ pull_number: options.pr }))
  if (pullRequest.head.repo?.full_name !== pullRequest.base.repo.full_name) {
    throw new Error(`PR #${options.pr} comes from a fork; its branch must be in ${options.org}/${adminRepo}`)
  }
  if (pullRequest.state !== 'open') {
    // A merged PR's changes have already been synced, and later commits may have changed the same config
    throw new Error(`PR #${options.pr} is ${pullRequest.merged_at ? 'merged' : 'closed'}. The dry run only checks open PRs.`)
  }
  const ref = pullRequest.head.ref
  // Read config at the PR's head commit, not its branch, so a push during the run can't mix two
  // versions of the config, and the report can say exactly which commit it checked
  const sha = pullRequest.head.sha
  // Check the commit can be read before loading config: ConfigManager logs a failed read and
  // carries on, then fails with "Cannot read properties of undefined (reading 'data')"
  try {
    await octokit.rest.repos.getCommit(context.repo({ ref: sha }))
  } catch (error) {
    throw new Error(`Couldn't read ${ref} (${sha}) in ${options.org}/${adminRepo} (${error.status || error.message}). Check the branch still exists and the token can read that repository's contents.`)
  }
  const prFiles = await octokit.paginate(octokit.rest.pulls.listFiles, context.repo({ pull_number: options.pr, per_page: 100 }))
  // listFiles gives the PR's current diff, not the diff at sha. Check the PR hasn't moved since
  // pulls.get, so the files that decide which repos to evaluate match the config being read.
  const { data: pullRequestAfterFiles } = await octokit.rest.pulls.get(context.repo({ pull_number: options.pr }))
  if (pullRequestAfterFiles.head.sha !== sha || pullRequestAfterFiles.base.sha !== pullRequest.base.sha) {
    throw new Error(`PR #${options.pr} changed while the dry run was starting (a push to it or its base branch). Run it again.`)
  }
  const files = prFiles.map(f => f.filename)
  // A renamed file is gone from its old path, so treat that path as removed. The app syncs
  // only the new path on merge, as a push lists a rename as one file removed and one added.
  const renamedFrom = prFiles.filter(f => f.status === 'renamed' && f.previous_filename).map(f => f.previous_filename)
  const removedFiles = new Set([...prFiles.filter(f => f.status === 'removed').map(f => f.filename), ...renamedFrom])
  const baseComparison = await compareWithBase(octokit, context, pullRequest, CONFIG_PATH, log)

  const deploymentConfig = withDefaultRestrictedRepos(DeploymentConfig.config)
  const runtimeConfig = await new ConfigManager(context, sha).loadGlobalSettingsYaml()
  const config = Object.assign({}, deploymentConfig, runtimeConfig)
  // Settings runs validator scripts as JavaScript, and the PR's settings.yml would otherwise
  // replace the deployment config's. Take them only from the local deployment config, so that
  // checking someone else's PR never runs their code with your token.
  config.configvalidators = deploymentConfig.configvalidators
  config.overridevalidators = deploymentConfig.overridevalidators

  const LocalSettings = createLocalSettingsClass(Settings, options)
  const settings = new LocalSettings(true, context, context.repo(), config, sha)

  const fullSync = files.includes(Settings.FILE_PATH)
  const { repoChanges, subOrgChanges } = getChangedConfigs(Settings, files, options.org)

  // A misspelt --repos name would filter out every repo and read as "No changes"
  if (options.repos) {
    await assertReposInOrg(settings, '--repos', options.repos, options.org)
  }

  const assumedSuborgPath = options.assumeSuborg && path.posix.join(CONFIG_PATH, 'suborgs', `${options.assumeSuborg}.yml`)
  if (assumedSuborgPath) {
    const suborgConfig = await settings.loadYaml(assumedSuborgPath)
    if (!suborgConfig) {
      throw new Error(`--assume-suborg: ${assumedSuborgPath} not found at ${ref}`)
    }
    if (!suborgConfig.suborgproperties) {
      throw new Error(`--assume-suborg: ${assumedSuborgPath} has no suborgproperties, so a custom property change can't make repos members`)
    }
    await assertReposInOrg(settings, '--assume-repos', options.assumeRepos, options.org)
    settings.assumedMembership = { repos: options.assumeRepos, suborgProperties: JSON.stringify(suborgConfig.suborgproperties) }
    // Evaluate the assumed repos as if their repo config files had changed
    for (const repo of options.assumeRepos) {
      if (!repoChanges.some(r => r.repo === repo)) {
        repoChanges.push({ repo, owner: options.org })
      }
    }
  }

  // Repos covered by the PR's changed repo and suborg files
  const changedRepos = new Set(repoChanges.map(r => r.repo))
  // Includes a renamed suborg file's old path, so its former members are checked for leaving.
  // Not in subOrgChanges: the file isn't there at the head, and the app doesn't sync it.
  const changedSubOrgPaths = new Set([
    ...subOrgChanges.map(s => s.path),
    ...renamedFrom.filter(file => Settings.SUB_ORG_PATTERN.test(file))
  ])
  const selectedSync = repoChanges.length > 0 || changedSubOrgPaths.size > 0
  let changedRepoGlobs = []
  let orgResults = []

  // Suborg membership at the head commit, with every suborg's repos. Used for the repos leaving
  // a changed suborg and for the membership summary.
  const membershipResolver = new LocalSettings(true, context, context.repo(), config, sha)
  membershipResolver.assumedMembership = settings.assumedMembership
  let leavingRepos = []
  // Why membership at the head commit couldn't be resolved, if it couldn't. Reported after the run
  // unless the run hits a membership failure too (such as a suborg conflict) and reports that.
  let headMembershipError
  if (changedSubOrgPaths.size > 0) {
    try {
      membershipResolver.subOrgConfigs = await membershipResolver.getSubOrgConfigs()
    } catch (error) {
      headMembershipError = membershipResolver.results.find(r => r.type === 'ERROR')?.action?.msg || error.message
    }
    if (!headMembershipError) {
      try {
        // Compare with the commit the branch was made from, not the base branch's latest commit:
        // a repo added to the suborg on the base branch since then isn't leaving
        const baseSha = baseComparison.mergeBase || pullRequest.base.sha
        leavingRepos = await findLeavingRepos({ LocalSettings, context, config, baseSha, after: membershipResolver, changedSubOrgPaths })
      } catch (error) {
        settings.logError(`Couldn't work out which repos leave the changed suborgs: ${error.message}`)
      }
    }
  }

  // --repos and --assume-repos add repos to those the PR covers. On a full sync with
  // --only-changed, which evaluates only the repos the PR covers, they're kept, and so are repos
  // leaving a changed suborg: the full sync applies to them too.
  const listedRepos = new Set([...(options.repos || []), ...(options.assumeRepos || [])])
  if (fullSync && options.onlyChanged) {
    leavingRepos.forEach(l => listedRepos.add(l.repo))
  }
  const onlyChanged = fullSync && options.onlyChanged
  settings.skipRepo = repoName => onlyChanged && !listedRepos.has(repoName) && !changedRepoGlobs.some(glob => glob.test(repoName))

  // Repos evaluated for their next sync rather than the merge, and why: 'leaving' a changed
  // suborg, or 'listed' with --repos but not covered by the PR
  const nextSyncRepos = []

  // Results that apply at the next sync of their repo rather than when the PR merges
  const deferredResults = new Set()

  const updateOrg = async () => {
    if (!options.skipOrgSettings) {
      await settings.updateOrg()
    }
    orgResults = settings.results.slice()
  }

  try {
    if (fullSync) {
      // Same steps as Settings.syncAll, except that org-level settings come first. They don't
      // depend on suborg config, and loadConfigs() stops the run on a suborg conflict, where the
      // app would carry on and still report them.
      await updateOrg()
      await settings.loadConfigs()
      // Work out suborg membership now: on a full sync no suborg filter is applied, so
      // subOrgConfigs covers every suborg.
      for (const [pattern, subOrgConfig] of Object.entries(settings.subOrgConfigs || {})) {
        if (changedSubOrgPaths.has(subOrgConfig.source)) {
          changedRepos.add(pattern)
        }
      }
      // suborgrepos entries can be globs, so match with the same Glob class Settings uses
      changedRepoGlobs = [...changedRepos].map(pattern => new Glob(pattern))
      await settings.updateAll()
    } else if (selectedSync || options.repos) {
      // Same steps as Settings.syncSelectedRepos. A PR that changes no config syncs nothing on
      // merge, but --repos are still evaluated below, for their next sync.
      if (selectedSync) {
        await updateOrg()
      }
      for (const repo of repoChanges) {
        settings.repo = repo
        await settings.loadConfigs(repo)
        if (settings.isRestricted(repo.repo)) {
          continue
        }
        await settings.updateRepos(repo)
      }
      for (const suborg of subOrgChanges) {
        settings.subOrgConfigMap = [suborg]
        settings.suborgChange = true
        await settings.loadConfigs()
        await settings.updateAll()
      }
      // The app only syncs the repos the PR covers when it merges. Repos leaving a suborg, and
      // --repos the PR doesn't cover, get the new config at their next sync. Evaluate them with
      // every suborg's config and mark their results as applying then.
      const archived = new Set((await settings.listOrgRepositories()).filter(r => r.archived).map(r => r.name))
      const notYetEvaluated = repo => !settings.evaluatedRepos.has(repo) && !settings.isRestricted(repo) && !archived.has(repo)
      for (const leaving of leavingRepos.filter(l => notYetEvaluated(l.repo))) {
        leaving.later = true
        nextSyncRepos.push({ repo: leaving.repo, reason: 'leaving' })
      }
      for (const repo of (options.repos || []).filter(notYetEvaluated)) {
        if (!nextSyncRepos.some(r => r.repo === repo)) {
          nextSyncRepos.push({ repo, reason: 'listed' })
        }
      }
      if (nextSyncRepos.length > 0) {
        settings.subOrgConfigMap = undefined
        settings.suborgChange = false
        await settings.loadConfigs()
        const start = settings.results.length
        for (const { repo } of nextSyncRepos) {
          await settings.updateRepos({ owner: options.org, repo })
        }
        settings.results.slice(start).forEach(result => deferredResults.add(result))
      }
    }
  } catch (error) {
    settings.logError(error.message)
  }

  let adminAccess = { reposWithoutAdmin: [], reposAdminUnknown: [] }
  try {
    adminAccess = await checkAdminAccess(settings)
  } catch (error) {
    settings.logError(`Couldn't check admin access to the evaluated repos: ${error.message}`)
  }

  // Skip the summary if membership already failed to resolve; the run reports why.
  const suborgPaths = [...new Set([...changedSubOrgPaths, ...(assumedSuborgPath ? [assumedSuborgPath] : [])])]
  let suborgMembership = []
  const membershipFailed = Boolean(settings.membershipUnresolved)
  if (headMembershipError && !membershipFailed) {
    settings.logError(`Couldn't work out which repos leave the changed suborgs: suborg membership at the head commit couldn't be resolved: ${headMembershipError}`)
  }
  if (suborgPaths.length > 0 && !membershipFailed) {
    try {
      suborgMembership = await describeSuborgMembership(membershipResolver, suborgPaths, Glob, leavingRepos, removedFiles)
    } catch (error) {
      settings.logError(`Couldn't list suborg membership: ${error.message}`)
    }
  }

  const results = dedupeResults(settings.results).map((result, index, all) => {
    return Object.assign({}, result, {
      scope: orgResults.includes(result) ? 'org' : 'repo',
      ...(deferredResults.has(result) && { deferred: true }),
      ...(isNewBranchProtection(result, all[index - 1]) && { action: newBranchProtectionChange(result) })
    })
  })

  const mode = fullSync ? 'full' : selectedSync ? 'selected' : 'none'
  return {
    pr: options.pr,
    ref,
    sha,
    baseComparison,
    mode,
    onlyChanged,
    skippedOrgSettings: !!options.skipOrgSettings && mode !== 'none',
    suborgMembership,
    leavingRepos: leavingRepos.map(({ repo, from, to, later }) => ({
      repo,
      from,
      to,
      evaluated: settings.evaluatedRepos.has(repo),
      // A full sync applies to every repo; otherwise only if the run covered it for another reason
      appliesOnMerge: fullSync || (settings.evaluatedRepos.has(repo) && !later)
    })),
    nextSyncRepos,
    ...adminAccess,
    results,
    errors: settings.errors,
    apiRequests: requestCount()
  }
}

// Some plugins return the same array of results more than once (Branches returns it once per
// branch), so results arrive duplicated. Settings.handleResults keeps only the first result per
// type, plugin and repo, which also drops different results, such as Repository's topic changes
// after its other changes, or every branch's protection changes after the first. Drop only
// results that are identical.
function dedupeResults (results) {
  const seen = new Set()
  return results.filter(result => {
    const key = JSON.stringify([result.type, result.plugin, result.repo, result.endpoint, result.body, result.action])
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

// The Branches plugin reports changes to a branch's protection as a diff, followed straight away
// by an "Add Branch Protection" action with the request. For a branch with no protection yet, it
// reports only the action, which has no diff, so it would read as no change. Pick those out: an
// "Add Branch Protection" that doesn't follow a Branches diff for the same repo.
function isNewBranchProtection (result, previous) {
  if (result.type !== 'INFO' || result.plugin !== 'Branches' || result.action?.msg !== 'Add Branch Protection' || !result.endpoint) {
    return false
  }
  const followsDiff = previous && previous.plugin === 'Branches' && previous.repo === result.repo && hasChanges(previous)
  return !followsDiff
}

// The request body as a diff, shaped like the branches config, as reports show only the diff
function newBranchProtectionChange (result) {
  const branch = decodeURIComponent(result.endpoint.match(/\/branches\/([^/]+)\/protection$/)?.[1] ?? '')
  // The request's own parameters, in case the endpoint left them in the body
  const { owner, repo, branch: _branch, headers, ...protection } = result.body || {}
  return {
    msg: `Branch protection will be added to the ${branch} branch, which has none`,
    additions: { branches: [{ name: branch, protection }] },
    modifications: {},
    deletions: {}
  }
}

function hasChanges (result) {
  const { action } = result
  return action && !(action.additions === null && action.deletions === null && action.modifications === null)
}

function formatValue (value) {
  if (value === null || value === undefined) {
    return ''
  }
  return JSON.stringify(value, null, 2)
}

// Fields GitHub adds to a ruleset it returns, which aren't part of the config
const RULESET_API_FIELDS = ['id', 'node_id', 'source', 'source_type', 'created_at', 'updated_at', 'current_user_can_bypass', '_links']

// A deleted ruleset is reported as GitHub returned it. Drop the fields that aren't config, for
// the text report only (--json keeps them). With no deletions the value is {}, left as it is.
function withoutRulesetApiFields (result, key, value) {
  if (result.plugin !== 'Rulesets' || key !== 'deletions' || !Array.isArray(value)) {
    return value
  }
  return value.map(ruleset => {
    if (ruleset === null || typeof ruleset !== 'object') {
      return ruleset
    }
    return Object.fromEntries(Object.entries(ruleset).filter(([field]) => !RULESET_API_FIELDS.includes(field)))
  })
}

function formatChange (result) {
  const lines = [`== ${result.plugin} / ${result.repo}`]
  for (const key of ['additions', 'deletions', 'modifications']) {
    const value = formatValue(withoutRulesetApiFields(result, key, result.action[key]))
    if (value && value !== '{}' && value !== '[]') {
      lines.push(`  ${key}:`, ...value.split('\n').map(l => `    ${l}`))
    }
  }
  return lines
}

function formatBaseComparison (comparison) {
  if (!comparison) {
    return []
  }
  if (comparison.error) {
    return [`Note: couldn't check whether the branch is behind ${comparison.base} (${comparison.error}).`, '']
  }
  const { base, aheadBy, configFilesChanged, allFilesListed } = comparison
  if (!aheadBy) {
    return []
  }
  const behind = `the branch is ${aheadBy} commit(s) behind ${base}`
  if (configFilesChanged.length > 0 || !allFilesListed) {
    const what = configFilesChanged.length > 0
      ? `and those commits change config files: ${configFilesChanged.join(', ')}`
      : 'and those commits change more files than GitHub lists, so config files may be among them'
    return [`Warning: ${behind}, ${what}.`,
      'The results use the branch\'s config without them. Update the branch for accurate results.', '']
  }
  return [`Note: ${behind}. None of those commits change config files.`, '']
}

function formatLeaving (suborg) {
  if (!suborg.leaving?.length) {
    return []
  }
  const repos = suborg.leaving.map(l => `${l.repo} (${l.to ? `goes to ${l.to}` : 'no suborg'})`)
  return [`  leaving with this PR: ${repos.join(', ')}`]
}

function formatMembership (suborg) {
  if (suborg.deleted) {
    return [`${suborg.path}: deleted in this PR`, ...formatLeaving(suborg)]
  }
  const members = suborg.members.filter(m => m.resolvesTo === suborg.path)
  const lines = [`${suborg.path}: ${members.length} repo(s)`]
  const width = Math.max(0, ...suborg.members.map(m => m.repo.length))
  for (const m of suborg.members) {
    const notes = [m.via.join(', ')]
    if (m.archived) {
      notes.push('archived, so skipped')
    }
    if (m.resolvesTo !== suborg.path) {
      notes.push(m.resolvesTo ? `but goes to ${m.resolvesTo}, which matched first` : 'but resolves to no suborg')
    }
    lines.push(`  ${m.repo.padEnd(width)}  ${notes.join('; ')}`)
  }
  if (suborg.unmatchedPatterns.length > 0) {
    lines.push(`  suborgrepos entries that match no repo: ${suborg.unmatchedPatterns.join(', ')}`)
  }
  lines.push(...formatLeaving(suborg))
  return lines
}

function formatReport (report) {
  const lines = [`Dry run for PR #${report.pr} (branch ${report.ref}, ${report.mode} sync)`, '']
  const allChanges = report.results.filter(r => r.type !== 'ERROR' && hasChanges(r))
  const changes = allChanges.filter(r => !r.deferred)
  const laterChanges = allChanges.filter(r => r.deferred)
  const laterRepos = report.nextSyncRepos || []
  const errors = report.results.filter(r => r.type === 'ERROR')

  lines.push(...formatBaseComparison(report.baseComparison))

  if (report.reposWithoutAdmin?.length > 0) {
    lines.push('Warning: results for these repos are unreliable. The token doesn\'t have admin on them,',
      'so GitHub hides some of their settings, which can show up as changes that aren\'t real:',
      `  ${report.reposWithoutAdmin.join(', ')}`, '')
  }
  if (report.reposAdminUnknown?.length > 0) {
    lines.push('Note: GitHub didn\'t say whether the token has admin on these repos. Without it, results',
      'can show changes that aren\'t real:',
      `  ${report.reposAdminUnknown.join(', ')}`, '')
  }

  if (report.suborgMembership.length > 0) {
    lines.push('Suborg membership with this PR:')
    for (const suborg of report.suborgMembership) {
      lines.push(...formatMembership(suborg).map(l => `  ${l}`))
    }
    lines.push('')
  }

  if (report.mode === 'none') {
    lines.push('No Safe Settings changes detected in this PR.')
  } else if (changes.length === 0) {
    const noChanges = laterRepos.length > 0 ? 'No changes when this PR merges' : 'No changes'
    lines.push(hasErrors(report) ? `${noChanges} found, but the run had errors (see below).` : `${noChanges}.`)
  }
  for (const r of changes) {
    lines.push(...formatChange(r))
  }
  if (laterRepos.length > 0) {
    const why = { leaving: 'leaving a changed suborg', listed: 'from --repos' }
    lines.push('', `Repos not covered by this PR: ${laterRepos.map(r => `${r.repo} (${why[r.reason]})`).join(', ')}`,
      'Safe Settings doesn\'t sync these when this PR merges. These changes apply the next time it',
      'syncs each repo:')
    if (laterChanges.length === 0) {
      lines.push('No changes.')
    }
    for (const r of laterChanges) {
      lines.push(...formatChange(r))
    }
  }
  if (report.onlyChanged) {
    lines.push('', 'This PR changes the global settings file, which can affect any repo, but only org-level',
      'settings, the repos covered by its changed repo and suborg files, and repos given with',
      '--repos or --assume-repos were evaluated. Use --repos to check other repos.')
  }
  if (report.skippedOrgSettings) {
    lines.push('', 'Org-level settings (org rulesets) were skipped. Check them in the dry run Safe Settings',
      'posts on the PR.')
  }

  if (errors.length > 0 || report.errors.length > 0) {
    lines.push('', 'Errors:')
    for (const r of errors) {
      lines.push(`  ${r.plugin} / ${r.repo}: ${r.action?.msg ?? formatValue(r.action)}`)
    }
    for (const e of report.errors) {
      lines.push(`  ${e.plugin}${e.repo ? ` / ${e.repo}` : ''}: ${e.msg}`)
    }
  }
  lines.push('', `${report.apiRequests} API requests made.`)
  return lines.join('\n')
}

function hasErrors (report) {
  return report.errors.length > 0 || report.results.some(r => r.type === 'ERROR')
}

async function main (argv = process.argv.slice(2)) {
  let options
  try {
    options = parseCliArgs(argv)
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`)
    return 2
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  if (!process.env.GITHUB_TOKEN) {
    console.error('GITHUB_TOKEN must be set')
    return 2
  }

  const log = createLogger(process.env.LOG_LEVEL || 'warn')
  const report = await run(options, { token: process.env.GITHUB_TOKEN, log })
  console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report))
  return hasErrors(report) ? 1 : 0
}

if (require.main === module) {
  main().then(code => { process.exitCode = code }, error => {
    console.error(process.env.LOG_LEVEL === 'debug' ? error : `Error: ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { main, run, parseCliArgs, withDefaultRestrictedRepos, getChangedConfigs, createOctokit, createLocalSettingsClass, createLogger, dedupeResults, formatReport }
