import * as vscode from 'vscode';

export function getResourceWorkspaceFolder(resource: vscode.Uri): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.getWorkspaceFolder(resource)
    ?? (resource.scheme === 'untitled' ? vscode.workspace.workspaceFolders?.[0] : undefined);
}

export function getConfigurationResource(resource: vscode.Uri): vscode.Uri {
  if (resource.scheme !== 'untitled') {
    return resource;
  }
  return getResourceWorkspaceFolder(resource)?.uri ?? resource;
}
