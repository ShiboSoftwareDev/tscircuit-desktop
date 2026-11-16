import { createHash, createHmac, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import type { IncomingMessage } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import { APIError, Sandbox } from "../.cache/preview-tools/node_modules/@vercel/sandbox/dist/index.js"
import { createProxyServer } from "../.cache/preview-tools/node_modules/httpxy/dist/index.mjs"
import { getHostedOrigins, sandboxAccessHeader, sandboxHealthPath, sandboxPort } from "./lib/hosted-review.ts"

const commit = process.env.VERCEL_GIT_COMMIT_SHA
if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
  throw new Error("The review gateway requires a Git-backed Vercel preview.")
}

const origins = new Map(getHostedOrigins().map((origin) => [new URL(origin).host, origin]))
const revision = commit.slice(0, 12)
const image = `dockerfile:${revision}`
const cookieName = "__Host-tscircuit-review"
const toolsDirectory = "/app/.cache/preview-tools/node_modules/.bin"
const workspaces = new Map<string, Promise<string>>()
const proxy = createProxyServer()

function sandboxCredentials(request: IncomingMessage) {
  const token = request.headers["x-vercel-oidc-token"] ?? process.env.VERCEL_OIDC_TOKEN
  if (typeof token !== "string") throw new Error("The request has no Vercel OIDC token.")
  const encodedClaims = token.split(".")[1]
  if (!encodedClaims) throw new Error("The Vercel OIDC token has no claims.")
  const { owner_id: teamId, project_id: projectId } = JSON.parse(
    Buffer.from(encodedClaims, "base64url").toString("utf8"),
  )
  if (typeof teamId !== "string" || typeof projectId !== "string") {
    throw new Error("The Vercel OIDC token does not identify a project.")
  }
  if (process.env.VERCEL_PROJECT_ID && process.env.VERCEL_PROJECT_ID !== projectId) {
    throw new Error("The Vercel OIDC token belongs to a different project.")
  }
  return { token, teamId, projectId }
}

function identifyReviewer(request: IncomingMessage) {
  return request.headers.cookie?.split(/;\s*/)
    .find((cookie) => cookie.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1)
    .match(/^[0-9a-f]{64}$/)?.[0]
}

async function isReady(target: string, key: string) {
  try {
    const response = await fetch(new URL(sandboxHealthPath, target), {
      headers: { [sandboxAccessHeader]: key },
      redirect: "error",
      signal: AbortSignal.timeout(1500),
    })
    return response.status === 204
  } catch {
    return false
  }
}

async function startWorkspace(
  name: string,
  origin: string,
  key: string,
  credentials: ReturnType<typeof sandboxCredentials>,
) {
  const sandbox = await Sandbox.getOrCreate({
    ...credentials,
    name,
    image,
    ports: [sandboxPort],
    // Review sessions start from the deployment image and need no snapshot.
    persistent: false,
    resume: true,
    timeout: 30 * 60 * 1000,
  }).catch((error) => {
    if (!(error instanceof APIError) || error.response.status !== 409) throw error
    return Sandbox.get({ ...credentials, name, resume: true })
  })
  const target = sandbox.domain(sandboxPort)
  if (await isReady(target, key)) return target

  // Multiple Vercel instances can reach a new or resumed workspace at once.
  // Only one process may open the workspace database and serve the app.
  await sandbox.runCommand({
    cmd: "/usr/bin/flock",
    args: [
      "-n", "/tmp/tscircuit-review.lock",
      `${toolsDirectory}/node`, "scripts/review-preview.ts", "--sandbox",
    ],
    cwd: "/app",
    env: {
      PATH: `${toolsDirectory}:/usr/local/bin:/usr/bin:/bin`,
      TMPDIR: "/tmp",
      PREVIEW_ORIGIN: origin,
      REVIEW_SANDBOX_KEY: key,
    },
    detached: true,
  })

  for (let attempt = 0; attempt < 24; attempt++) {
    if (await isReady(target, key)) return target
    await delay(500)
  }
  throw new Error("The sandbox app did not start.")
}

async function prepareRequest(request: IncomingMessage, origin: string, reviewer: string) {
  const name = `review-${createHash("sha256").update(revision).update(reviewer).digest("hex").slice(0, 32)}`
  const key = createHmac("sha256", reviewer).update(revision).digest("hex")
  let workspace = workspaces.get(name)
  if (!workspace) {
    workspace = startWorkspace(name, origin, key, sandboxCredentials(request))
    workspaces.set(name, workspace)
    const forget = () => workspaces.delete(name)
    void workspace.then(() => setTimeout(forget, 15_000).unref(), forget)
  }

  // The workspace only needs its own key. Vercel's gateway cookies and
  // platform headers stay in the protected deployment.
  delete request.headers.cookie
  for (const name of Object.keys(request.headers)) {
    if (name.startsWith("x-vercel-") || name.startsWith("x-forwarded-")) delete request.headers[name]
  }
  request.headers[sandboxAccessHeader] = key
  request.headers["x-forwarded-host"] = new URL(origin).host
  request.headers["x-forwarded-proto"] = "https"
  return { target: await workspace, changeOrigin: true }
}

const gateway = createServer((request, response) => {
  const origin = origins.get(request.headers.host ?? "")
  if (!origin) {
    response.writeHead(421).end()
    return
  }

  const reviewer = identifyReviewer(request)
  if (!reviewer) {
    if (request.method === "GET" && request.url === "/") {
      const cookie = `${cookieName}=${randomBytes(32).toString("hex")}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`
      response.writeHead(303, { Location: "/", "Set-Cookie": cookie, "Cache-Control": "no-store" }).end()
    } else {
      response.writeHead(401, { "Cache-Control": "no-store" }).end("Open the preview link to start a workspace.")
    }
    return
  }

  void prepareRequest(request, origin, reviewer).then((options) => proxy.web(request, response, options))
    .catch((error: unknown) => {
      const sandboxStatus = error instanceof APIError ? error.response.status : undefined
      const sandboxCode = error instanceof APIError ? error.json?.error?.code : undefined
      let reason = "workspace unavailable"
      if (sandboxStatus) {
        reason = `Sandbox API HTTP ${sandboxStatus}`
        if (typeof sandboxCode === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(sandboxCode)) {
          reason += ` (${sandboxCode})`
        }
      } else if (error instanceof Error && error.message === "The request has no Vercel OIDC token.") {
        reason = error.message
      }
      console.error(`Review preview: ${reason}`)
      if (!response.headersSent) {
        response.setHeader("Cache-Control", "no-store")
        if (sandboxStatus !== 402) response.setHeader("Retry-After", "5")
        response.writeHead(503)
      }
      response.end(sandboxStatus === 402
        ? "The preview host has reached its Vercel Sandbox allowance."
        : "The review workspace is unavailable. Reload to reconnect.")
    })
})

gateway.on("upgrade", (request, socket, head) => {
  const origin = origins.get(request.headers.host ?? "")
  const reviewer = identifyReviewer(request)
  if (!origin || !reviewer) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
    return
  }
  void prepareRequest(request, origin, reviewer)
    .then((options) => proxy.ws(request, socket, options, head))
    .catch(() => socket.destroy())
})

gateway.listen(Number(process.env.PORT ?? 80), "0.0.0.0")
