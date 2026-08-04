// Regression test for: Teams plugin nop-mode diff reports phantom additions/deletions
// for teams whose GitHub display `name` differs from their `slug` (e.g. "Platform
// Engineering" vs. `platform-engineering`), even when nothing has actually changed.
//
// This file is excluded from the upstream sync workflow (.github/workflows/sync-upstream.yml)
// so it survives syncs. lib/plugins/teams.js itself is NOT excluded, so an upstream sync can
// (and eventually will) overwrite it with the unpatched version - reverting the local fix this
// test guards. If this file fails after a sync, that's exactly what happened: re-apply the fix
// below to lib/plugins/teams.js's find(), after the checkSecurityManager() call:
//
//   return teams.map(team => ({ ...team, name: team.slug }))
//
// Upstream issue: https://github.com/github-community-projects/safe-settings/issues/1033
const any = require('@travi/any')
const Teams = require('../../../../lib/plugins/teams')

const LOCAL_PATCH_REVERTED_NOTICE = `
################################################################################
# LOCAL PATCH MISSING FROM lib/plugins/teams.js
#
# Teams.find() is no longer normalizing each team's \`name\` to its \`slug\`.
# This is almost certainly because an upstream sync overwrote lib/plugins/teams.js
# with the unpatched upstream version (that file is intentionally NOT excluded
# from sync-upstream.yml, so it must be re-patched by hand after syncs that
# touch it).
#
# Re-apply in Teams.find(), after the checkSecurityManager() call:
#   return teams.map(team => ({ ...team, name: team.slug }))
################################################################################
`

describe('Teams - slug vs display name nop diff', () => {
  let github
  const org = 'bkeepers'
  const teamSlug = 'platform-engineering'
  const teamDisplayName = 'Platform Engineering'
  const teamId = any.integer()

  function configure (config, { nop = true } = {}) {
    const log = { debug: jest.fn(), error: console.error }
    const errors = []
    return new Teams(nop, github, { owner: org, repo: 'test' }, config, log, errors)
  }

  function mockExistingTeam (overrides = {}) {
    github = {
      paginate: jest.fn()
        .mockImplementation(async (fetch, params) => {
          if (typeof fetch !== 'function') {
            return []
          }
          const response = await fetch(params)
          return response.data
        }),
      rest: {
        teams: {
          create: jest.fn().mockResolvedValue(),
          getByName: jest.fn(),
          addOrUpdateRepoPermissionsInOrg: jest.fn().mockResolvedValue()
        },
        repos: {
          listTeams: jest.fn().mockResolvedValue({
            data: [
              {
                id: teamId,
                slug: teamSlug,
                name: teamDisplayName,
                permission: 'push',
                notification_setting: 'notifications_enabled',
                ...overrides
              }
            ]
          })
        }
      },
      request: Object.assign(jest.fn().mockResolvedValue(), {
        endpoint: jest.fn().mockReturnValue({})
      })
    }
  }

  it('reports no changes when only the display name differs from the slug', async () => {
    mockExistingTeam()

    const plugin = configure([
      { name: teamSlug, permission: 'push' }
    ])

    const result = await plugin.sync()

    // sync() only resolves with an array of NopCommands when compareDeep detects a change.
    // Before the fix, the name/slug mismatch made compareDeep report the whole team as an
    // addition + deletion even though nothing changed, so this would be a populated array.
    if (result !== undefined) {
      throw new Error(
        `${LOCAL_PATCH_REVERTED_NOTICE}\n` +
        'Expected sync() to resolve with no nop output for an unchanged team, but got:\n' +
        JSON.stringify(result, null, 2)
      )
    }

    expect(github.request).not.toHaveBeenCalled()
    expect(github.rest.teams.addOrUpdateRepoPermissionsInOrg).not.toHaveBeenCalled()
  })

  it('still reports a genuine permission change without noise from the name/slug mismatch', async () => {
    mockExistingTeam({ permission: 'pull' })

    const plugin = configure([
      { name: teamSlug, permission: 'push' }
    ])

    const result = await plugin.sync()

    // result[0] is the informational summary NopCommand produced by compareDeep;
    // result[1] is the actual PUT action produced by update().
    const [summary] = result || []
    const hasPhantomDiff =
      !summary ||
      !summary.action ||
      JSON.stringify(summary.action.additions) !== JSON.stringify({}) ||
      JSON.stringify(summary.action.deletions) !== JSON.stringify({})

    if (hasPhantomDiff) {
      throw new Error(
        `${LOCAL_PATCH_REVERTED_NOTICE}\n` +
        'Expected only a `permission` modification (no additions/deletions) for a team whose ' +
        'permission genuinely changed, but got:\n' +
        JSON.stringify(result, null, 2)
      )
    }

    expect(summary.action.modifications).toEqual([
      expect.objectContaining({ permission: 'push' })
    ])
  })
})
