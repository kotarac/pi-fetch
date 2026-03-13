import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { convertWithVisitor, JsCodeBlockStyle, type JsConversionOptions, JsHeadingStyle, type JsNodeContext, JsPreprocessingPreset } from '@kreuzberg/html-to-markdown-node'
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from '@mariozechner/pi-coding-agent'
import { Type } from '@sinclair/typebox'

const skipTags = new Set([
  'amp-iframe',
  'amp-img',
  'amp-video',
  'audio',
  'button',
  'canvas',
  'datalist',
  'embed',
  'fieldset',
  'form',
  'frame',
  'frameset',
  'iframe',
  'img',
  'input',
  'keygen',
  'label',
  'legend',
  'meter',
  'object',
  'optgroup',
  'option',
  'output',
  'picture',
  'progress',
  'select',
  'source',
  'svg',
  'textarea',
  'track',
  'video',
])
const conversionVisitor = {
  async visitElementStart(payload: string): Promise<string> {
    if (typeof payload !== 'string' || payload.length === 0) return JSON.stringify({ type: 'continue' })
    let nodeContext: JsNodeContext
    try {
      nodeContext = JSON.parse(payload) as JsNodeContext
    } catch {
      return JSON.stringify({ type: 'continue' })
    }
    const rawTagName = typeof nodeContext.tagName === 'string' ? nodeContext.tagName : ''
    const tagName = rawTagName.replace(/\/+$/, '').toLowerCase()
    if (!tagName) return JSON.stringify({ type: 'continue' })
    if (skipTags.has(tagName)) return JSON.stringify({ type: 'skip' })
    return JSON.stringify({ type: 'continue' })
  },
}
const conversionOptions: JsConversionOptions = {
  preprocessing: { enabled: true, preset: JsPreprocessingPreset.Aggressive, removeNavigation: true, removeForms: true },
  headingStyle: JsHeadingStyle.Atx,
  codeBlockStyle: JsCodeBlockStyle.Backticks,
}

function rewriteGithubBlobUrlToRaw(parsed: URL): URL | undefined {
  const hostname = parsed.hostname.toLowerCase()
  if (hostname !== 'github.com' && hostname !== 'www.github.com') return undefined
  const segments = parsed.pathname
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
  if (segments.length < 5) return undefined
  const decodedSegments: string[] = []
  for (const segment of segments) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return undefined
    }
    if (!decoded) return undefined
    if (decoded.includes('/')) return undefined
    decodedSegments.push(decoded)
  }
  if (decodedSegments.length < 5) return undefined
  const [owner, repo, kind, ref, ...fileSegments] = decodedSegments
  if (kind !== 'blob' && kind !== 'raw') return undefined
  if (!owner || !repo || !ref || fileSegments.length === 0) return undefined
  const raw = new URL('https://raw.githubusercontent.com/')
  raw.pathname = `/${owner}/${repo}/${ref}/${fileSegments.join('/')}`
  raw.search = ''
  raw.hash = ''
  return raw
}

function rewriteUrlForFetch(parsed: URL): URL {
  const rewritten = rewriteGithubBlobUrlToRaw(parsed)
  if (rewritten) return rewritten
  return parsed
}

function getCandidateHostname(candidate: string): string | undefined {
  const endIndex = candidate.search(/[/?#]/)
  const hostPort = (endIndex === -1 ? candidate : candidate.slice(0, endIndex)).trim()
  if (!hostPort) return undefined
  if (hostPort.startsWith('[')) {
    const closeIndex = hostPort.indexOf(']')
    if (closeIndex === -1) return undefined
    return hostPort.slice(1, closeIndex)
  }
  const colonIndex = hostPort.indexOf(':')
  return colonIndex === -1 ? hostPort : hostPort.slice(0, colonIndex)
}

function shouldDefaultToHttp(candidate: string): boolean {
  const hostname = getCandidateHostname(candidate)
  if (!hostname) return false
  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost') return true
  if (normalized.endsWith('.localhost')) return true
  if (normalized === '127.0.0.1') return true
  if (normalized === '0.0.0.0') return true
  if (normalized === '::1') return true
  return false
}

function normalizeUrl(rawUrl: string): string | undefined {
  if (typeof rawUrl !== 'string') return undefined
  const trimmedUrl = rawUrl.trim()
  if (!trimmedUrl) return undefined
  const normalizedUrl = trimmedUrl.startsWith('@') ? trimmedUrl.slice(1) : trimmedUrl
  const candidate = normalizedUrl.startsWith('//') ? `https:${normalizedUrl}` : normalizedUrl
  const schemeWithSlashes = candidate.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//)
  let urlToParse = candidate
  if (schemeWithSlashes) {
    const scheme = schemeWithSlashes[1].toLowerCase()
    if (scheme !== 'http' && scheme !== 'https') return undefined
  }
  if (!schemeWithSlashes) {
    const schemeLike = candidate.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)
    if (schemeLike && !/^[^/]+:\d+(?:\/|$)/.test(candidate)) return undefined
    const scheme = shouldDefaultToHttp(candidate) ? 'http' : 'https'
    urlToParse = `${scheme}://${candidate}`
  }
  try {
    const parsed = new URL(urlToParse)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return rewriteUrlForFetch(parsed).toString()
  } catch {
    return undefined
  }
}

function getErrorInfo(error: unknown): { message: string; code?: string } {
  if (!error || typeof error !== 'object') return { message: String(error) }
  const record = error as Record<string, unknown>
  const code = typeof record.code === 'string' ? record.code : undefined
  const message = typeof record.message === 'string' ? record.message : String(error)
  return { message, code }
}

type FetchToolDetails = {
  url: string
  cancelled?: boolean
  error?: string
  errorCode?: string
  finalUrl?: string
  statusCode?: number
  contentType?: string
  converted?: boolean
  truncated?: boolean
  binary?: boolean
  tempFile?: string
  tempFileError?: string
  outputLines?: number
  totalLines?: number
  outputBytes?: number
  totalBytes?: number
  conversionInputBytes?: number
  conversionInputTruncated?: boolean
  conversionError?: string
}

function getHeaderValue(headerLines: string[], key: string): string | undefined {
  const normalizedKey = key.toLowerCase()
  for (const line of headerLines) {
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) continue
    const name = line.slice(0, colonIndex).trim().toLowerCase()
    if (name !== normalizedKey) continue
    return line.slice(colonIndex + 1).trim()
  }
  return undefined
}

function normalizeContentType(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const semicolonIndex = trimmed.indexOf(';')
  const mediaType = semicolonIndex === -1 ? trimmed : trimmed.slice(0, semicolonIndex)
  const normalized = mediaType.trim().toLowerCase()
  if (!normalized) return undefined
  return normalized
}

function isMarkdownContentType(contentType: string | undefined): boolean {
  const normalized = normalizeContentType(contentType)
  if (!normalized) return false
  if (normalized === 'text/markdown') return true
  if (normalized === 'text/x-markdown') return true
  return false
}

function isHtmlContentType(contentType: string | undefined): boolean {
  const normalized = normalizeContentType(contentType)
  if (!normalized) return false
  if (normalized === 'text/html') return true
  if (normalized === 'application/xhtml+xml') return true
  return false
}

function looksLikeHtml(body: string): boolean {
  const trimmed = body
    .trimStart()
    .slice(0, 32 * 1024)
    .toLowerCase()
  if (!trimmed) return false
  if (trimmed.startsWith('<!doctype')) return true
  if (trimmed.startsWith('<html')) return true
  if (trimmed.startsWith('<?xml')) return true
  if (trimmed.startsWith('<head')) return true
  if (trimmed.startsWith('<body')) return true
  return false
}

function isTextualContentType(contentType: string | undefined): boolean {
  const normalized = normalizeContentType(contentType)
  if (!normalized) return true
  if (normalized.startsWith('text/')) return true
  if (normalized.includes('json')) return true
  if (normalized.includes('xml')) return true
  if (normalized.includes('javascript')) return true
  return false
}

type CurlExecResult = {
  code: number
  stdout: Buffer
  stderr: string
}

const CURL_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'
const MAX_CURL_STDOUT_BYTES = 12 * 1024 * 1024

async function execCurl(args: string[], timeoutMs: number, signal: AbortSignal | undefined): Promise<CurlExecResult> {
  if (!Array.isArray(args) || args.length === 0) throw new Error('Missing curl args')
  if (timeoutMs <= 0) throw new Error('Invalid timeout')
  if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'ABORT_ERR' })
  return await new Promise((resolve, reject) => {
    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let settled = false
    let timedOut = false
    let stdoutBytes = 0
    let stdoutTooLarge = false
    let sigKillTimer: NodeJS.Timeout | undefined

    const finish = (result: CurlExecResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error)
    }

    const kill = () => {
      try {
        child.kill('SIGTERM')
      } catch {
        return
      }
      if (sigKillTimer) return
      sigKillTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          return
        }
      }, 1000)
      sigKillTimer.unref()
    }

    const timeoutId = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)

    const onAbort = () => kill()
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk) => {
      if (!Buffer.isBuffer(chunk)) return
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_CURL_STDOUT_BYTES) {
        stdoutTooLarge = true
        kill()
        return
      }
      stdoutChunks.push(chunk)
    })

    child.stderr?.on('data', (chunk) => {
      if (!Buffer.isBuffer(chunk)) return
      stderrChunks.push(chunk)
    })

    child.on('error', (error) => {
      clearTimeout(timeoutId)
      if (sigKillTimer) clearTimeout(sigKillTimer)
      signal?.removeEventListener('abort', onAbort)
      const info = getErrorInfo(error)
      if (info.code === 'ENOENT') {
        fail(Object.assign(new Error('curl is not installed or not available in PATH'), { code: info.code }))
        return
      }
      fail(Object.assign(new Error(info.message), { code: info.code }))
    })

    child.on('close', (code, _signal) => {
      clearTimeout(timeoutId)
      if (sigKillTimer) clearTimeout(sigKillTimer)
      signal?.removeEventListener('abort', onAbort)
      if (timedOut) {
        fail(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }))
        return
      }
      if (signal?.aborted) {
        fail(Object.assign(new Error('Cancelled'), { code: 'ABORT_ERR' }))
        return
      }
      if (stdoutTooLarge) {
        fail(Object.assign(new Error(`curl output exceeded limit of ${formatSize(MAX_CURL_STDOUT_BYTES)}; refusing to return partial content`), { code: 'ETOOBIG' }))
        return
      }
      const stdout = Buffer.concat(stdoutChunks)
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      finish({ code: code ?? 1, stdout, stderr })
    })
  })
}

function parseWriteOut(stderr: string): { statusCode?: number; effectiveUrl?: string } {
  if (!stderr) return {}
  const startMarker = '\nPI_FETCH_CURL_WRITEOUT_START\n'
  const endMarker = '\nPI_FETCH_CURL_WRITEOUT_END\n'
  const startIndex = stderr.lastIndexOf(startMarker)
  if (startIndex === -1) return {}
  const endIndex = stderr.indexOf(endMarker, startIndex + startMarker.length)
  if (endIndex === -1) return {}
  const meta = stderr.slice(startIndex + startMarker.length, endIndex).trim()
  const [statusLine, urlLine] = meta.split(/\r?\n/)
  const statusCode = statusLine ? Number.parseInt(statusLine.trim(), 10) : undefined
  const effectiveUrl = urlLine?.trim() ? urlLine.trim() : undefined
  return {
    statusCode: Number.isFinite(statusCode) ? statusCode : undefined,
    effectiveUrl,
  }
}

function stripWriteOut(stderr: string): string {
  if (!stderr) return ''
  const startMarker = '\nPI_FETCH_CURL_WRITEOUT_START\n'
  const endMarker = '\nPI_FETCH_CURL_WRITEOUT_END\n'
  const startIndex = stderr.lastIndexOf(startMarker)
  if (startIndex === -1) return stderr
  const endIndex = stderr.indexOf(endMarker, startIndex + startMarker.length)
  if (endIndex === -1) return stderr
  const tailIndex = endIndex + endMarker.length
  return `${stderr.slice(0, startIndex)}${stderr.slice(tailIndex)}`
}

function parseHeaderFile(contents: string): string[] {
  if (!contents) return []
  const normalized = contents.replace(/\r\n/g, '\n')
  const blocks = normalized
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
  const headerBlocks = blocks.filter((block) => /^HTTP\//i.test(block))
  const lastBlock = headerBlocks.length > 0 ? headerBlocks[headerBlocks.length - 1] : ''
  if (!lastBlock) return []
  return lastBlock
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

type CurlCapabilities =
  | {
      kind: 'available'
      http2Supported: boolean
      http3Supported: boolean
    }
  | {
      kind: 'missing'
      error: string
    }

async function detectCurlCapabilities(timeoutMs: number): Promise<CurlCapabilities> {
  if (timeoutMs <= 0) throw new Error('Invalid timeout')
  try {
    const result = await execCurl(['-V'], timeoutMs, undefined)
    if (result.code !== 0)
      return {
        kind: 'missing',
        error: result.stderr.trim() || `curl -V failed with exit code ${result.code}`,
      }
    const output = result.stdout.toString('utf8')
    const http2Supported = /(?:^|\n)Features:.*\bHTTP2\b/i.test(output)
    const http3Supported = /(?:^|\n)Features:.*\bHTTP3\b/i.test(output)
    return { kind: 'available', http2Supported, http3Supported }
  } catch (error) {
    const info = getErrorInfo(error)
    const message = info.message || 'Failed to run curl -V'
    if (info.code === 'ENOENT')
      return {
        kind: 'missing',
        error: 'curl is not installed or not available in PATH',
      }
    return { kind: 'missing', error: message }
  }
}

async function curlGet(
  url: string,
  httpHeaders: string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
  http2Supported: boolean,
  http3Supported: boolean,
): Promise<{ statusCode: number; body: Buffer; headerLines: string[]; effectiveUrl?: string }> {
  if (!url) throw new Error('Missing URL')
  if (timeoutMs <= 0) throw new Error('Invalid timeout')
  if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'ABORT_ERR' })

  const headerDirectory = await mkdtemp(path.join(os.tmpdir(), 'pi-fetch-curl-'))
  const headerPath = path.join(headerDirectory, 'headers.txt')
  try {
    const writeOut = '%{stderr}\nPI_FETCH_CURL_WRITEOUT_START\n%{http_code}\n%{url_effective}\nPI_FETCH_CURL_WRITEOUT_END\n'
    const maxTimeSeconds = Math.max(1, Math.ceil(timeoutMs / 1000))
    const maxFileSizeBytes = 10 * 1024 * 1024
    const args = ['--silent', '--show-error', '--location', '--max-redirs', '5', '--compressed', '--connect-timeout', '10', '--max-time', String(maxTimeSeconds), '--max-filesize', String(maxFileSizeBytes)]
    const httpArgs = http3Supported ? ['--http3'] : http2Supported ? ['--http2'] : []
    args.push(...httpArgs)
    for (const header of httpHeaders) {
      args.push('--header', header)
    }
    args.push('--dump-header', headerPath, '--output', '-', '--write-out', writeOut, '--', url)

    const result = await execCurl(args, timeoutMs + 2000, signal)
    if (result.code !== 0) {
      const exitCode = result.code
      if (exitCode === 63) throw Object.assign(new Error(`Response exceeds ${formatSize(maxFileSizeBytes)} limit`), { code: 'ETOOBIG' })
      const errorText = stripWriteOut(result.stderr).trim()
      throw Object.assign(new Error(errorText || `curl failed with exit code ${exitCode}`), { code: String(exitCode) })
    }

    const headerText = await readFile(headerPath, 'utf8').catch(() => '')
    const headerLines = parseHeaderFile(headerText)
    const parsedWriteOut = parseWriteOut(result.stderr)
    const statusCode = parsedWriteOut.statusCode
    if (!statusCode) throw new Error('Failed to parse HTTP status code from curl output')
    return {
      statusCode,
      body: result.stdout,
      headerLines,
      effectiveUrl: parsedWriteOut.effectiveUrl,
    }
  } finally {
    await rm(headerDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function writeTempFile(content: Uint8Array, fileName: string, tempDirectories: string[], maxTempDirectories: number): Promise<string> {
  if (!fileName) throw new Error('Missing file name')
  if (maxTempDirectories <= 0) throw new Error('Invalid max temp directories')
  const staleDirectories: string[] = []
  while (tempDirectories.length >= maxTempDirectories) {
    const staleDirectory = tempDirectories.shift()
    if (!staleDirectory) break
    staleDirectories.push(staleDirectory)
  }
  if (staleDirectories.length > 0) await Promise.all(staleDirectories.map((staleDirectory) => rm(staleDirectory, { recursive: true, force: true }).catch(() => undefined)))
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-fetch-'))
  tempDirectories.push(directory)
  const outputPath = path.join(directory, fileName)
  await writeFile(outputPath, content)
  return outputPath
}

type TruncationResult = {
  text: string
  details: Pick<FetchToolDetails, 'truncated' | 'tempFile' | 'tempFileError' | 'outputLines' | 'totalLines' | 'outputBytes' | 'totalBytes'>
}

async function truncateAndMaybeSave(fullText: string, fileName: string, tempDirectories: string[], maxTempDirectories: number): Promise<TruncationResult> {
  if (!fullText) return { text: '', details: { truncated: false } }
  const truncation = truncateHead(fullText, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  })
  if (!truncation.truncated) return { text: truncation.content, details: { truncated: false } }
  let tempFile: string | undefined
  let tempFileError: string | undefined
  try {
    tempFile = await writeTempFile(Buffer.from(fullText, 'utf8'), fileName, tempDirectories, maxTempDirectories)
  } catch (error) {
    tempFileError = getErrorInfo(error).message
  }
  let text = truncation.content
  text += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`
  if (tempFile) text += ` Full output saved to: ${tempFile}]`
  if (!tempFile) text += ` Full output could not be saved to a temp file: ${tempFileError || 'unknown error'}]`
  return {
    text,
    details: {
      truncated: true,
      tempFile,
      tempFileError,
      outputLines: truncation.outputLines,
      totalLines: truncation.totalLines,
      outputBytes: truncation.outputBytes,
      totalBytes: truncation.totalBytes,
    },
  }
}

export default function (pi: ExtensionAPI) {
  const maxTempDirectories = 10
  const tempDirectories: string[] = []
  let curlCapabilities: CurlCapabilities | undefined
  let curlCapabilitiesPromise: Promise<CurlCapabilities> | undefined
  const ensureCurlCapabilities = async (): Promise<CurlCapabilities> => {
    if (curlCapabilities) return curlCapabilities
    if (!curlCapabilitiesPromise)
      curlCapabilitiesPromise = detectCurlCapabilities(5000).then((capabilities) => {
        curlCapabilities = capabilities
        return capabilities
      })
    return await curlCapabilitiesPromise
  }
  pi.on('session_start', async (_event, ctx) => {
    const capabilities = await ensureCurlCapabilities()
    if (capabilities.kind === 'available') return
    ctx.ui.notify(`pi-fetch: ${capabilities.error} (the fetch tool will not work until curl is installed).`, 'error')
  })
  pi.on('session_shutdown', async () => {
    if (tempDirectories.length === 0) return
    const directories = tempDirectories.splice(0, tempDirectories.length)
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }).catch(() => undefined)))
  })
  pi.registerTool({
    name: 'fetch',
    label: 'Fetch',
    description: 'Fetch a web URL. Output is truncated to 50KB/2000 lines.',
    promptSnippet: 'Fetch a web URL and return the page content',
    promptGuidelines: ['Use this tool when the user provides a URL and you need the page contents.', 'Prefer this tool over asking the user to copy/paste page content.'],
    parameters: Type.Object({
      url: Type.String({ description: 'The web http(s) URL to fetch' }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      if (signal?.aborted)
        return {
          content: [{ type: 'text', text: 'Cancelled' }],
          details: { url: params.url, cancelled: true } satisfies FetchToolDetails,
        }
      const url = normalizeUrl(params.url)
      if (!url)
        return {
          content: [
            {
              type: 'text',
              text: 'Invalid URL. Provide an absolute http(s) URL, e.g. https://example.com',
            },
          ],
          isError: true,
          details: { url: params.url } satisfies FetchToolDetails,
        }
      const timeoutMs = 30_000
      const httpHeaders = ['Accept: text/html, application/xhtml+xml;q=0.9, */*;q=0.8', 'Accept-Language: en-US,en;q=0.9', `User-Agent: ${CURL_USER_AGENT}`]
      let response: Awaited<ReturnType<typeof curlGet>>
      try {
        const capabilities = await ensureCurlCapabilities()
        if (capabilities.kind === 'missing')
          return {
            content: [{ type: 'text', text: capabilities.error }],
            isError: true,
            details: { url, error: capabilities.error, errorCode: 'ENOENT' } satisfies FetchToolDetails,
          }
        response = await curlGet(url, httpHeaders, timeoutMs, signal, capabilities.http2Supported, capabilities.http3Supported)
      } catch (error) {
        if (signal?.aborted)
          return {
            content: [{ type: 'text', text: 'Cancelled' }],
            details: { url, cancelled: true } satisfies FetchToolDetails,
          }
        const info = getErrorInfo(error)
        return {
          content: [{ type: 'text', text: info.message }],
          isError: true,
          details: { url, error: info.message, errorCode: info.code } satisfies FetchToolDetails,
        }
      }
      if (signal?.aborted)
        return {
          content: [{ type: 'text', text: 'Cancelled' }],
          details: { url, cancelled: true } satisfies FetchToolDetails,
        }
      const headerLines = response.headerLines
      const contentTypeRaw = getHeaderValue(headerLines, 'content-type')
      const contentType = normalizeContentType(contentTypeRaw)
      const finalUrl = response.effectiveUrl || url
      const statusCode = response.statusCode
      const bodyBytes = response.body
      if (bodyBytes.length === 0)
        return {
          content: [{ type: 'text', text: 'No output.' }],
          details: { url, finalUrl, statusCode, contentType } satisfies FetchToolDetails,
        }
      const createTextResult = (text: string, details: FetchToolDetails, isError?: boolean) => {
        const result = {
          content: [{ type: 'text' as const, text }],
          details,
        }
        if (isError === undefined) return result
        return { ...result, isError }
      }
      if (isMarkdownContentType(contentType)) {
        const output = bodyBytes.toString('utf8').trim()
        if (!output) return createTextResult('No output.', { url, finalUrl, statusCode, contentType } satisfies FetchToolDetails)
        const truncationResult = await truncateAndMaybeSave(output, 'output.md', tempDirectories, maxTempDirectories)
        return createTextResult(
          truncationResult.text,
          {
            url,
            finalUrl,
            statusCode,
            contentType,
            converted: false,
            ...truncationResult.details,
          } satisfies FetchToolDetails,
          statusCode >= 400,
        )
      }
      const sniffBytes = bodyBytes.subarray(0, 64 * 1024)
      const sniffText = sniffBytes.toString('utf8')
      const sniffedHtml = !isHtmlContentType(contentType) ? looksLikeHtml(sniffText) : false
      if (!isTextualContentType(contentType) && !sniffedHtml) {
        let tempFile: string | undefined
        let tempFileError: string | undefined
        try {
          tempFile = await writeTempFile(bodyBytes, 'output.bin', tempDirectories, maxTempDirectories)
        } catch (error) {
          tempFileError = getErrorInfo(error).message
        }
        let text = `Fetched ${formatSize(bodyBytes.length)} of ${contentType || 'unknown content-type'} from ${finalUrl}.`
        if (tempFile) text += ` Saved to: ${tempFile}`
        if (!tempFile) text += ` Could not save to a temp file: ${tempFileError || 'unknown error'}`
        return {
          content: [{ type: 'text', text }],
          details: {
            url,
            finalUrl,
            statusCode,
            contentType,
            converted: false,
            binary: true,
            tempFile,
            tempFileError,
            totalBytes: bodyBytes.length,
          } satisfies FetchToolDetails,
          isError: true,
        }
      }
      if (isHtmlContentType(contentType) || sniffedHtml) {
        const maxConversionBytes = 2 * 1024 * 1024
        const conversionInput = bodyBytes.length > maxConversionBytes ? bodyBytes.subarray(0, maxConversionBytes) : bodyBytes
        let converted: string
        try {
          converted = (await convertWithVisitor(conversionInput.toString('utf8'), conversionOptions, conversionVisitor)).trim()
        } catch (error) {
          const conversionError = getErrorInfo(error).message
          const output = bodyBytes.toString('utf8').trim()
          if (!output)
            return createTextResult(
              'No output.',
              {
                url,
                finalUrl,
                statusCode,
                contentType,
                converted: false,
                conversionError,
              } satisfies FetchToolDetails,
              statusCode >= 400,
            )
          const truncationResult = await truncateAndMaybeSave(output, 'output.html', tempDirectories, maxTempDirectories)
          return createTextResult(
            truncationResult.text,
            {
              url,
              finalUrl,
              statusCode,
              contentType,
              converted: false,
              conversionError,
              ...truncationResult.details,
            } satisfies FetchToolDetails,
            statusCode >= 400,
          )
        }
        if (!converted)
          return createTextResult(
            'No output.',
            {
              url,
              finalUrl,
              statusCode,
              contentType,
              converted: true,
              conversionInputBytes: conversionInput.length,
              conversionInputTruncated: conversionInput.length !== bodyBytes.length,
            } satisfies FetchToolDetails,
            statusCode >= 400,
          )
        const truncationResult = await truncateAndMaybeSave(converted, 'output.md', tempDirectories, maxTempDirectories)
        return createTextResult(
          truncationResult.text,
          {
            url,
            finalUrl,
            statusCode,
            contentType,
            converted: true,
            conversionInputBytes: conversionInput.length,
            conversionInputTruncated: conversionInput.length !== bodyBytes.length,
            ...truncationResult.details,
          } satisfies FetchToolDetails,
          statusCode >= 400,
        )
      }
      const decodedBody = bodyBytes.toString('utf8')
      const output = decodedBody.trim()
      if (!output) return createTextResult('No output.', { url, finalUrl, statusCode, contentType } satisfies FetchToolDetails, statusCode >= 400)
      const truncationResult = await truncateAndMaybeSave(output, 'output.html', tempDirectories, maxTempDirectories)
      return createTextResult(
        truncationResult.text,
        {
          url,
          finalUrl,
          statusCode,
          contentType,
          converted: false,
          ...truncationResult.details,
        } satisfies FetchToolDetails,
        statusCode >= 400,
      )
    },
  })
}
