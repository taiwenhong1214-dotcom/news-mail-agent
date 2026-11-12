import type { Env } from "./env";

/** 触发 GitHub Actions 流水线（workflow_dispatch）。成功返回 null，失败返回错误描述。 */
export async function dispatchPipeline(
  env: Env,
  inputs: Record<string, string> = {},
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<string | null> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return "未配置 GITHUB_TOKEN / GITHUB_REPO";
  const workflow = env.GITHUB_WORKFLOW || "pipeline.yml";
  const r = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "news-agent-worker",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: "main", ...(Object.keys(inputs).length ? { inputs } : {}) }),
  });
  if (r.status === 204) return null;
  return `GitHub HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`;
}
