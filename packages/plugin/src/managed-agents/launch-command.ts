// Orca shell/launch primitives adapted for an admitted Host transport. MIT; see ORCA-LICENSE.
/** Quoting alone does not provide remote process ownership. These plans are not
 * executable capabilities until a Host registers an owned SSH/WSL transport. */
export function quoteManagedPosix(value: string): string {
  if (value.includes('\0')) throw new Error('Invalid process argument.')
  return `'${value.replace(/'/g, "'\\''")}'`
}
export function managedPosixCommand(command: string, args: readonly string[], cwd: string, profileHome?: { key: 'CODEX_HOME' | 'CLAUDE_CONFIG_DIR'; path: string }): string {
  if (!cwd.startsWith('/') || (profileHome && !profileHome.path.startsWith('/'))) throw new Error('Remote paths must be absolute POSIX paths.')
  return `cd ${quoteManagedPosix(cwd)} && exec ${profileHome ? `env ${profileHome.key}=${quoteManagedPosix(profileHome.path)} ` : ''}${[command, ...args].map(quoteManagedPosix).join(' ')}`
}
/** Fixed options prevent a remotely selected name becoming an SSH option.
 * Credentials remain in the system SSH agent/config; no keys or passwords in argv. */
export function managedSshArguments(alias: string, remoteCommand: string): string[] {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,253}$/.test(alias)) throw new Error('Invalid Host SSH alias.')
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '--', alias, remoteCommand]
}
/** Orca's --exec boundary; never run this through cmd.exe. The Windows adapter
 * must select a stable native cwd and own/close the guest process tree. */
export function managedWslArguments(distribution: string, remoteCommand: string, user?: string): string[] {
  if (!distribution || /[\0\r\n]/.test(distribution) || (user !== undefined && (!user || /[\0\r\n]/.test(user)))) throw new Error('Invalid WSL target.')
  return ['-d', distribution, ...(user ? ['-u', user] : []), '--exec', '/bin/sh', '-c', remoteCommand]
}
