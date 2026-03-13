import assert from 'node:assert/strict'
import test from 'node:test'
import { __test__ } from './fetch.ts'

test('getCandidateHostname extracts host from host:port and strips ipv6 brackets', () => {
  assert.equal(__test__.getCandidateHostname('example.com:443/a?b'), 'example.com')
  assert.equal(__test__.getCandidateHostname('[::1]:8080'), '::1')
  assert.equal(__test__.getCandidateHostname('[::1'), undefined)
})

test('shouldDefaultToHttp is true for localhost and loopback targets', () => {
  assert.equal(__test__.shouldDefaultToHttp('localhost:3000'), true)
  assert.equal(__test__.shouldDefaultToHttp('api.localhost/path'), true)
  assert.equal(__test__.shouldDefaultToHttp('127.0.0.1:8080'), true)
  assert.equal(__test__.shouldDefaultToHttp('0.0.0.0:8080'), true)
  assert.equal(__test__.shouldDefaultToHttp('[::1]:8080'), true)
  assert.equal(__test__.shouldDefaultToHttp('example.com'), false)
})

test('normalizeUrl trims, strips leading @, and preserves valid https urls', () => {
  assert.equal(__test__.normalizeUrl('  @https://example.com/path  '), 'https://example.com/path')
})

test('normalizeUrl defaults to https when scheme is missing', () => {
  assert.equal(__test__.normalizeUrl('example.com'), 'https://example.com/')
})

test('normalizeUrl defaults to http for localhost targets', () => {
  assert.equal(__test__.normalizeUrl('localhost:3000'), 'http://localhost:3000/')
  assert.equal(__test__.normalizeUrl('127.0.0.1:8080/test'), 'http://127.0.0.1:8080/test')
  assert.equal(__test__.normalizeUrl('api.localhost/path'), 'http://api.localhost/path')
})

test('normalizeUrl supports protocol-relative urls', () => {
  assert.equal(__test__.normalizeUrl('//example.com/a'), 'https://example.com/a')
})

test('normalizeUrl accepts host:port without scheme but rejects scheme-like non-host inputs', () => {
  assert.equal(__test__.normalizeUrl('example:80/path'), 'https://example:80/path')
  assert.equal(__test__.normalizeUrl('example:abc'), undefined)
})

test('normalizeUrl rejects non-http(s) schemes', () => {
  assert.equal(__test__.normalizeUrl('ftp://example.com'), undefined)
  assert.equal(__test__.normalizeUrl('mailto:test@example.com'), undefined)
})

test('normalizeUrl returns undefined for empty input', () => {
  assert.equal(__test__.normalizeUrl('   '), undefined)
})

test('normalizeUrl rewrites github blob urls to raw and drops query/hash', () => {
  assert.equal(__test__.normalizeUrl('https://github.com/owner/repo/blob/main/dir/file.txt?x=1#y'), 'https://raw.githubusercontent.com/owner/repo/main/dir/file.txt')
  assert.equal(__test__.normalizeUrl('https://www.github.com/owner/repo/raw/main/dir/file.txt'), 'https://raw.githubusercontent.com/owner/repo/main/dir/file.txt')
})

test('normalizeUrl does not rewrite github blob urls containing encoded slashes in path segments', () => {
  assert.equal(__test__.normalizeUrl('https://github.com/owner/repo/blob/main/dir%2Ffile.txt'), 'https://github.com/owner/repo/blob/main/dir%2Ffile.txt')
})

test('getHeaderValue matches case-insensitively and trims', () => {
  const headerLines = ['Content-Type: text/html; charset=utf-8', 'X-Test:  ok  ']
  assert.equal(__test__.getHeaderValue(headerLines, 'content-type'), 'text/html; charset=utf-8')
  assert.equal(__test__.getHeaderValue(headerLines, 'X-Test'), 'ok')
  assert.equal(__test__.getHeaderValue(headerLines, 'missing'), undefined)
})

test('parseWriteOut extracts statusCode and effectiveUrl from curl stderr write-out block', () => {
  const stderr = ['curl: some warning', 'more text', 'PI_FETCH_CURL_WRITEOUT_START', '204', 'https://final.example/test', 'PI_FETCH_CURL_WRITEOUT_END', 'trailing noise'].join('\n')
  assert.deepEqual(__test__.parseWriteOut(stderr), { statusCode: 204, effectiveUrl: 'https://final.example/test' })
})

test('parseWriteOut returns empty object when markers are missing or status is invalid', () => {
  assert.deepEqual(__test__.parseWriteOut('no markers here'), {})
  const stderr = ['PI_FETCH_CURL_WRITEOUT_START', 'nope', 'https://final.example', 'PI_FETCH_CURL_WRITEOUT_END'].join('\n')
  assert.deepEqual(__test__.parseWriteOut(`\n${stderr}\n`), { statusCode: undefined, effectiveUrl: 'https://final.example' })
})

test('stripWriteOut removes the curl write-out block from stderr', () => {
  const stderr = ['line a', 'PI_FETCH_CURL_WRITEOUT_START', '200', 'https://final.example/', 'PI_FETCH_CURL_WRITEOUT_END', 'line b'].join('\n')
  assert.equal(__test__.stripWriteOut(stderr), 'line a\nline b')
})

test('stripWriteOut returns stderr unchanged when markers are missing', () => {
  assert.equal(__test__.stripWriteOut('a\nb'), 'a\nb')
})

test('parseHeaderFile returns the last HTTP header block (after redirects)', () => {
  const contents = ['HTTP/1.1 301 Moved Permanently\r\nLocation: https://example.com/\r\n\r\n', 'HTTP/2 200 \r\nContent-Type: text/html; charset=utf-8\r\nX-Test: ok\r\n\r\n'].join('')
  assert.deepEqual(__test__.parseHeaderFile(contents), ['HTTP/2 200', 'Content-Type: text/html; charset=utf-8', 'X-Test: ok'])
})

test('parseHeaderFile returns empty list when no HTTP header block is present', () => {
  assert.deepEqual(__test__.parseHeaderFile('X-Test: ok\n\nHello'), [])
})

test('looksLikeHtml detects html-like bodies', () => {
  assert.equal(__test__.looksLikeHtml('<!doctype html><html><body>Hi</body></html>'), true)
  assert.equal(__test__.looksLikeHtml('<?xml version="1.0"?><html></html>'), true)
  assert.equal(__test__.looksLikeHtml('hello world'), false)
})

test('normalizeContentType lowercases and removes charset parameters', () => {
  assert.equal(__test__.normalizeContentType('Text/HTML; charset=utf-8'), 'text/html')
})

test('content-type helper predicates behave as expected', () => {
  assert.equal(__test__.isMarkdownContentType('text/markdown; charset=utf-8'), true)
  assert.equal(__test__.isMarkdownContentType('text/x-markdown'), true)
  assert.equal(__test__.isHtmlContentType('text/html'), true)
  assert.equal(__test__.isHtmlContentType('application/xhtml+xml'), true)
  assert.equal(__test__.isTextualContentType(undefined), true)
  assert.equal(__test__.isTextualContentType('application/json'), true)
  assert.equal(__test__.isTextualContentType('application/octet-stream'), false)
})
