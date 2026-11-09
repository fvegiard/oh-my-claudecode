import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getDefaultMcpServers } from '../servers.js';
import { loadConfig } from '../../config/loader.js';

describe('Exa MCP server enablement', () => {
  let savedKey: string | undefined;
  let savedXdg: string | undefined;
  let emptyConfigHome: string;

  beforeEach(() => {
    savedKey = process.env.EXA_API_KEY;
    savedXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.EXA_API_KEY;
    // Keep loadConfig() independent of the developer's real user config.
    emptyConfigHome = mkdtempSync(join(tmpdir(), 'omc-exa-config-'));
    process.env.XDG_CONFIG_HOME = emptyConfigHome;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = savedKey;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    rmSync(emptyConfigHome, { recursive: true, force: true });
  });

  it('does not start Exa without an API key, even when enabled by default', () => {
    expect(getDefaultMcpServers().exa).toBeUndefined();
    expect(getDefaultMcpServers({ enableExa: true }).exa).toBeUndefined();
    expect(getDefaultMcpServers({ enableExa: true, exaApiKey: '' }).exa).toBeUndefined();
  });

  it('keeps Context7 independent of the Exa key', () => {
    expect(getDefaultMcpServers().context7).toBeDefined();
  });

  it('starts Exa when a key is supplied explicitly or via EXA_API_KEY', () => {
    const explicit = getDefaultMcpServers({ exaApiKey: 'fake-key' }).exa;
    expect(explicit?.env).toEqual({ EXA_API_KEY: 'fake-key' });

    process.env.EXA_API_KEY = 'fake-env-key';
    expect(getDefaultMcpServers().exa?.env).toEqual({ EXA_API_KEY: 'fake-env-key' });
  });

  it('honors an explicit disable even when a key is present', () => {
    expect(getDefaultMcpServers({ exaApiKey: 'fake-key', enableExa: false }).exa).toBeUndefined();
  });

  it('loadConfig leaves Exa disabled without a key and enables it with one', () => {
    expect(loadConfig().mcpServers?.exa?.enabled).toBe(false);

    process.env.EXA_API_KEY = 'fake-env-key';
    const config = loadConfig();
    expect(config.mcpServers?.exa).toEqual({ enabled: true, apiKey: 'fake-env-key' });
  });
});
