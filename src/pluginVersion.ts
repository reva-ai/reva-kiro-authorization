import * as fs from 'node:fs';
import * as path from 'node:path';

// Plugin PROTOCOL version — same as the Kiro marketplace plugin version
// (plugin.json), falling back to package.json.
function loadPluginVersion(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'plugin.json'), // dist/src → package root
    path.join(__dirname, '..', 'plugin.json'), // src → package root
    path.join(__dirname, '..', '..', 'package.json'),
    path.join(__dirname, '..', 'package.json'),
  ];
  for (const file of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const version = typeof raw?.version === 'string' ? raw.version.trim() : '';
      if (version) return version.replace(/^v/i, '');
    } catch {
      // try next
    }
  }
  return '1.0.0';
}

export const PLUGIN_VERSION = loadPluginVersion();

export const PLUGIN_VERSION_PATH = '/pdp/ai/access/v1/ai/plugin/version';

export const ERROR_TYPE_PLUGIN_VERSION_UNSUPPORTED = 'PLUGIN_VERSION_UNSUPPORTED';
export const ERROR_TYPE_PLUGIN_VERSION_INVALID = 'PLUGIN_VERSION_INVALID';
export const ERROR_TYPE_PLUGIN_VERSION_REQUIRED = 'PLUGIN_VERSION_REQUIRED';

export interface PluginVersionWindow {
  minimumSupportedVersion: string;
  currentVersion: string;
}

export function isPluginVersionErrorType(errorType: string | undefined): boolean {
  return (
    errorType === ERROR_TYPE_PLUGIN_VERSION_UNSUPPORTED ||
    errorType === ERROR_TYPE_PLUGIN_VERSION_INVALID ||
    errorType === ERROR_TYPE_PLUGIN_VERSION_REQUIRED
  );
}

export function unsupportedPluginVersionReason(
  pluginVersion: string,
  window?: PluginVersionWindow,
): string {
  if (window?.minimumSupportedVersion) {
    return (
      `Your current version ${pluginVersion} is outdated. ` +
      `Please update it to at least the minimum supported version ${window.minimumSupportedVersion}.`
    );
  }
  return `Your current version ${pluginVersion} is outdated. Please update the plugin.`;
}

export function invalidPluginVersionReason(): string {
  return 'Reva Security plugin version is invalid. Reinstall or update the plugin.';
}

type Semver = { major: number; minor: number; patch: number };

function parseSemver(raw: string): Semver | undefined {
  const value = raw.trim().replace(/^[vV]/, '');
  const parts = value.split('.');
  if (parts.length !== 3) return undefined;
  const nums: number[] = [];
  for (const part of parts) {
    if (!part || (part.length > 1 && part.startsWith('0')) || !/^\d+$/.test(part)) return undefined;
    nums.push(Number(part));
  }
  return { major: nums[0], minor: nums[1], patch: nums[2] };
}

function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** Returns true when pluginVersion is inside [minimum supported version, current]. */
export function isPluginVersionSupported(pluginVersion: string, window: PluginVersionWindow): boolean {
  const plugin = parseSemver(pluginVersion);
  const msp = parseSemver(window.minimumSupportedVersion);
  const current = parseSemver(window.currentVersion);
  if (!plugin || !msp || !current) return false;
  if (compareSemver(plugin, msp) < 0 || compareSemver(plugin, current) > 0) return false;
  if (plugin.major < msp.major || plugin.major > current.major) return false;
  return true;
}
