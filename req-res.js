const { EventEmitter } = require('events')
const { Readable, Writable } = require('streamx')

const BASE_URL = 'http://localhost'

function parseURL (url, query) {
  if ((typeof url === 'string' || Object.prototype.toString.call(url) === '[object String]') && url.startsWith('//')) {
    url = BASE_URL + url
  }
  const result = typeof url === 'object'
    ? Object.assign(new URL(BASE_URL), url)
    : new URL(url, BASE_URL)

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
    const { method = 'GET', url, query, remoteAddress = '127.0.0.1', body, enc, headers, authority } = opts

    super()

    this.httpVersion = '1.1'

    this.method = method.toUpperCase()
    const parsedURL = parseURL(url, query)
    this.url = parsedURL.pathname + parsedURL.search
    this.socket = new MockSocket(remoteAddress)
    this.headers = {}
    Object.keys(headers).forEach(k => {
      this.headers[k.toLowerCase()] = headers[k]
    })
    this.headers['user-agent'] = this.headers['user-agent'] || 'lightMyRequest'
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
    this.headers = {}
    this.payload = null
    this._payload = []
    this._keepAliveTimeout = keepAliveTimeout
  }

  hasHeader (name) {
    return name.toLowerCase() in this.headers
  }

  getHeader (name) {
    return this.headers[name]
  }

  getHeaders () {
    return this.headers
  }

  setHeader (name, value) {
    this.headers[name.toLowerCase()] = value
  }

  writeHead (statusCode, statusMessage, headers) {
    // we don't need statusMessage for aws lambda
    this.statusCode = statusCode

    if (typeof statusMessage === 'object') {
      headers = statusMessage
    }

    if (headers) {
      let key
      for (key in headers) {
        this.setHeader(key, headers[key])
      }
    }

    if (!('connection' in this.headers)) {
      this.headers['connection'] = 'keep-alive'
      if (this._keepAliveTimeout) {
        const timeoutSeconds = Math.floor(this._keepAliveTimeout / 1000)
        this.headers['keep-alive'] = `timeout=${timeoutSeconds}`
      }
    }

    if (!('date' in this.headers)) {
      this.headers['date'] = utcDate()
    }
  }

  _write (data, cb) {
    data = Buffer.isBuffer(data) ? data.toString('base64') : data
    // eslint-disable-next-line no-unused-expressions
    data | 0
    this._payload.push(data)
    cb(null)
  }

  _destroy (cb) {
    if (this._payload.length === 0) {
      this.payload = ''
      return cb(null)
    }
    if (this._payload.length === 1) {
      this.payload = this._payload[0]
      return cb(null)
    }
    this.payload = this._payload.join('')
    cb(null)
  }
}
