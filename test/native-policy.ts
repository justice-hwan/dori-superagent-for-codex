export function nativePolicyReply(
  thread: { id: string; cwd: string; model: string; status: string },
  params: Record<string, unknown>,
  mode: string,
) {
  let sandbox: Record<string, unknown> | undefined =
    params["sandbox"] === "danger-full-access"
      ? { type: "dangerFullAccess" }
      : {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        };
  let approvalPolicy: unknown = params["approvalPolicy"] ?? "on-request";
  if (mode === "policy-sandbox") sandbox = { type: "readOnly", networkAccess: false };
  if (mode === "policy-missing") sandbox = undefined;
  if (mode === "policy-extra") sandbox = { type: "dangerFullAccess", networkAccess: false };
  if (mode === "policy-approval") approvalPolicy = "on-request";
  if (mode === "policy-approval-missing") approvalPolicy = undefined;
  return {
    thread: { id: thread.id, cwd: thread.cwd, status: { type: thread.status } },
    cwd: thread.cwd,
    model: thread.model,
    modelProvider: "reported-provider",
    sandbox,
    approvalPolicy,
    activePermissionProfile: null,
    runtimeWorkspaceRoots: [thread.cwd],
  };
}
