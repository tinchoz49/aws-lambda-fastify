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

exports.Request = class Request extends Readable {
  constructor (opts = {}) {
    const { host = 'http://localhost', method = 'GET', url, query, remoteAddress = '127.0.0.1', body, enc, headers, authority } = opts

    super()

    this.httpVersion = '1.1'

    this.method = method.toUpperCase()
    const parsedURL = parseURL(host, url, query)
    this.url = parsedURL.pathname + parsedURL.search
    this.socket = new MockSocket(remoteAddress)
    this.headers = {}
    Object.keys(headers).forEach(k => {
      this.headers[k.toLowerCase()] = headers[k]
    })
    this.headers['user-agent'] = this.headers['user-agent'] || 'awsLambdaFastify'
    this.headers.host = this.headers.host || authority || hostHeaderFromURL(parsedURL)

    if (body) {
      this._body = Buffer.from(body, enc)
    }

    // NOTE: API Gateway is not setting Content-Length header on requests even when they have a body
    if (!this.headers['content-length']) {
      this.headers['content-length'] = this._body ? `${this._body.length}` : '0'
    }
  }

  setEncoding (enc) {
    this._enc = enc
  }

  _read (cb) {
    if (this._body) {
      this.push(this._enc ? this._body.toString(this._enc) : this._body)
    }

    this.push(null)
    cb(null)
  }
}

exports.Response = class Response extends Writable {
  constructor (opts = {}) {
    const { keepAliveTimeout = 0 } = opts

    super()

    this.statusCode = 200
    this.payload = null
    this.chunked = false
    this._headers = new Map()
    this._payload = []
    this._keepAliveTimeout = keepAliveTimeout
  }

  hasHeader (name) {
    return this._headers.has(name.toLowerCase())
  }

  getHeader (name) {
    const header = this._headers.get(name.toLowerCase())
    if (header) return header.value
  }

  getHeaders () {
    const headers = {}
    this._headers.forEach((header, key) => {
      headers[key] = header.value
    })
    return headers
  }

  setHeader (name, value) {
    const key = name.toLowerCase()

    if (key === 'transfer-encoding') {
      this.chunked = value.includes('chunked')
      return
    }

    this._headers.set(key, { name, value })
  }

  removeHeader (name) {
    this._headers.delete(name.toLowerCase())
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

  _write (data, cb) {
    data = Buffer.isBuffer(data) ? data.toString('base64') : data
    // eslint-disable-next-line no-unused-expressions
    data | 0
    this._payload.push(data)
    cb()
  }

  _destroy (cb) {
    if (this._payload.length === 0) {
      this.payload = ''
      return cb()
    }

    if (this._payload.length === 1) {
      this.payload = this._payload[0]
      return cb()
    }

    this.payload = this._payload.join('')
    cb()
  }
}
