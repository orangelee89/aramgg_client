import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/modules/logger.ts', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { parseMacProcessList, parseLcuAuthFromCommandLine } from '../../src/main/services/lcu/process-auth-discovery.ts'

describe('macOS League client process discovery', () => {
  it('picks League client processes out of ps output and keeps the command line for auth parsing', () => {
    const stdout = [
      '  412 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder',
      ' 8123 /Applications/League of Legends.app/Contents/LoL/LeagueClient.app/Contents/MacOS/LeagueClient --launch-product=league_of_legends',
      ' 8150 /Applications/League of Legends.app/Contents/LoL/LeagueClientUx.app/Contents/MacOS/LeagueClientUx --riotclient-auth-token=abc --app-port=63125 --remoting-auth-token=secret-token --app-name=LeagueClient',
      ' 8151 /Applications/League of Legends.app/Contents/LoL/LeagueClientUxRender.app/Contents/MacOS/LeagueClientUxRender --type=renderer',
    ].join('\n')

    const records = parseMacProcessList(stdout)

    expect(records.map((record) => [record.Name, record.ProcessId])).toEqual([
      ['LeagueClient', 8123],
      ['LeagueClientUx', 8150],
    ])
    expect(records[1].ExecutablePath).toBe('/Applications/League of Legends.app/Contents/LoL/LeagueClientUx.app/Contents/MacOS/LeagueClientUx')

    const [token, port] = parseLcuAuthFromCommandLine(records[1].CommandLine)
    expect(token).toBe('secret-token')
    expect(port).toBe('63125')
  })

  it('returns nothing when no League process is running', () => {
    expect(parseMacProcessList('  412 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder\n')).toEqual([])
  })
})
