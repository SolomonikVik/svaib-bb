/** Per-window navigation only; never used to authorize a company or select a chat's folder. */
export function lastCompanyWorkspace(accountId: string): string | null {
  try { return sessionStorage.getItem('svaib:last-workspace:' + accountId); } catch { return null; }
}
export function rememberCompanyWorkspace(accountId: string, workspaceId: string) {
  try { sessionStorage.setItem('svaib:last-workspace:' + accountId, workspaceId); } catch { /* Optional navigation convenience. */ }
}
