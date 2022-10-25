const { EventEmitter } = require('events')
const { Readable, Writable } = require('streamx')

function parseURL (host, url, query) {
  if ((typeof url === 'string' || Object.prototype.toString.call(url) === '[object String]') && url.startsWith('//')) {
    url = host + url
  }
  const result = typeof url === 'object'
    ? Object.assign(new URL(host), url)
    : new URL(url, host)

  const merged = Object.assign({}, url.query, query)
  for (const key in merged) {
    const value = merged[key]

    if (Array.isArray(value)) {
      result.searchParams.delete(key)
      for (const param of value) {
        result.searchParams.append(key, param)
      }
    } else {
      result.searchParams.set(key, value)
    }
  }

  return result
}

class MockSocket extends EventEmitter {
  constructor (remoteAddress) {
    super()
    this.remoteAddress = remoteAddress
    this.writable = true
    this.readable = true
  }
}

function hostHeaderFromURL (parsedURL) {
  return parsedURL.port
    ? parsedURL.host
    : parsedURL.hostname + (parsedURL.protocol === 'https:' ? ':443' : ':80')
}

let utcCache

function utcDate () {
  if (!utcCache) cache()
  return utcCache
}

function cache () {
  const d = new Date()
  utcCache = d.toUTCString()
  setTimeout(resetCache, 1000 - d.getMilliseconds())
}

function resetCache () {
  utcCache = undefined
}

function toBuffer (chunk) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
}
class Request extends Readable {
  constructor (opts = {}) {
    const { host = 'http://localhost', method = 'GET', url, query, remoteAddress = '127.0.0.1', body, enc, headers = {}, authority } = opts

    super()

    this.httpVersion = '1.1'

    this.method = method.toUpperCase()
    const parsedURL = parseURL(host, url, query)
    this.url = parsedURL.pathname + parsedURL.search
    this.socket = new MockSocket(remoteAddress)
    this.headers = headers
    this.headers['user-agent'] = this.headers['user-agent'] || 'awsLambdaFastify'
    this.headers.host = this.headers.host || authority || hostHeaderFromURL(parsedURL)

    this._body = body
    this._defaultEnc = enc

    // NOTE: API Gateway is not setting Content-Length header on requests even when they have a body
    if (!this.headers['content-length']) {
      this.headers['content-length'] = this._body ? String(Buffer.byteLength(this._body, enc)) : '0'
    }
  }

  setEncoding (enc) {
    this._enconding = enc
  }

  unpipe () {
    this.pause() // workaround for now
    return this
  }

  _read (cb) {
    if (this._body) {
      let payload
      if (this._enconding && this._enconding === this._defaultEnc) {
        payload = this._body
      } else {
        payload = Buffer.from(this._body, this._defaultEnc)
      }

      this.push(payload)
    }

    this.push(null)
    cb()
  }
}

class Response extends Writable {
  constructor (opts = {}) {
    const { keepAliveTimeout = 0 } = opts

    super()

    this.statusCode = 200
    this.headers = new Map()
    this._payloadAsBuffer = false
    this._payload = []
    this._keepAliveTimeout = keepAliveTimeout
  }

  hasHeader (name) {
    return this.headers.has(name.toLowerCase())
  }

  getHeader (name) {
    const header = this.headers.get(name.toLowerCase())
    if (header) return header.value
  }

  getHeaders () {
    const headers = {}
    this.headers.forEach((header, key) => {
      headers[key] = header.value
    })
    return headers
  }

  setHeader (name, value) {
    const key = name.toLowerCase()

    if (key === 'transfer-encoding' && value === 'chunked') return

    this.headers.set(key, { name, value })
  }

  removeHeader (name) {
    this.headers.delete(name.toLowerCase())
  }

  writeHead (statusCode, statusMessage, headers) {
    // we don't need statusMessage for aws lambda
    this.statusCode = statusCode

    if (typeof statusMessage === 'object') {
      headers = statusMessage
    }

    if (headers) {
      Object.keys(headers).forEach(key => {
        this.setHeader(key, headers[key])
      })
    }

    if (!(this.hasHeader('connection'))) {
      this.setHeader('connection', 'keep-alive')
      if (this._keepAliveTimeout) {
        this.setHeader('keep-alive', `timeout=${Math.floor(this._keepAliveTimeout / 1000)}`)
      }
    }

    if (!(this.hasHeader('date'))) {
      this.setHeader('date', utcDate())
    }
  }

  rawPayload (base64) {
    if (this._payload.length === 0) return ''

    if (base64 || this._payloadAsBuffer) {
      return Buffer.concat(this._payload.map(toBuffer)).toString(base64 ? 'base64' : 'utf8')
    }

    return this._payload.join('')
  }

  _write (data, cb) {
    const isBuffer = Buffer.isBuffer(data)

    if (isBuffer) {
      this._payloadAsBuffer = true
    } else {
      // eslint-disable-next-line no-unused-expressions
      data | 0
    }

    this._payload.push(data)
    cb()
  }
}

module.exports = (app) => {
  let isReady = false
  app.ready(() => {
    isReady = true
  })

  return function inject (event, cb) {
    const req = new Request(event)
    const res = new Response()

    let called = false
    res.once('error', err => {
      if (called) return
      called = true
      console.error(err)
      cb(err)
    })

    res.once('close', () => {
      if (called) return
      called = true
      cb(null, res)
    })

    if (isReady) return app.routing(req, res)
    app.ready(() => app.routing(req, res))
  }
}
