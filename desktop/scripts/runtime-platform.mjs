export function runtimeMinimumMacOS(componentSources) {
  const version = componentSources?.minimumMacOS;
  if (typeof version !== 'string' || version !== version.trim() || !/^[1-9]\d{0,2}\.(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2}))?$/.test(version)) throw new Error('runtime_minimum_macos_invalid');
  return version;
}
