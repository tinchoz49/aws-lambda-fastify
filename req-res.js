const { EventEmitter } = require('events')
const { Readable, Writable } = require('streamx')
const parseURL = require('./parse-url')

class MockSocket extends EventEmitter {
  constructor (remoteAddress) {
    super()
    this.remoteAddress = remoteAddress
  }
}

class QueryRefs {
  constructor () {
    this._refs = new Map()
    this._free = []
  }

  add (query) {
    let id
    if (this._free.length) {
      id = this._free.pop()
    } else {
      id = this._refs.size + 1
    }

    this._refs.set(id, query)
    return id
  }

  parse (str) {
    if (!str) return {}
    const id = Number(str.split('=')[1])
    if (id === undefined) return {}
    const query = this._refs.get(id)
    this._refs.delete(id)
    this._free.push(id)
    return query
  }
}

const queryRefs = new QueryRefs()

exports.queryRefs = queryRefs

/**
 * Get hostname:port
 *
 * @param {URL} parsedURL
 * @return {String}
 */
function hostHeaderFromURL (parsedURL) {
  return parsedURL.port
    ? parsedURL.host
    : parsedURL.hostname + (parsedURL.protocol === 'https:' ? ':443' : ':80')
}

exports.Request = class Request extends Readable {
  constructor (opts = {}) {
    let { method = 'GET', url, query, remoteAddress = '127.0.0.1', body, enc, headers, authority } = opts

    super()

    this.httpVersion = '1.1'

    this.method = method.toUpperCase()
    url = parseURL(url, query ? { ref: queryRefs.add(query) } : undefined)
    this.url = url.pathname + url.search
    this.socket = new MockSocket(remoteAddress)
    this.headers = {}
    Object.keys(headers).forEach(k => {
      this.headers[k.toLowerCase()] = headers[k]
    })
    this.headers['user-agent'] = this.headers['user-agent'] || 'lightMyRequest'
    this.headers.host = this.headers.host || authority || hostHeaderFromURL(url)

    // if (cookies) {
    //   const cookieValues = Object.keys(cookies).map(key => cookie.serialize(key, cookies[key]))
    //   if (this.headers.cookie) {
    //     cookieValues.unshift(this.headers.cookie)
    //   }
    //   this.headers.cookie = cookieValues.join('; ')
    // }

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

exports.Response = class Response extends Writable {
  constructor (opts = {}) {
    const { version, keepAliveTimeout = 0 } = opts

    super()

    this._version = version

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
    name = name.toLowerCase()
    const isArray = Array.isArray(value)

    if (name === 'set-cookie') {
      if (this._version === '2.0') {
        this.cookies = isArray ? value : [value]
        return true
      }

      if (isArray) {
        this.multiValueHeaders = {}
        this.multiValueHeaders['set-cookie'] = value
        return true
      }
    } else if (isArray) {
      value = value.join(',')
    }

    this.headers[name] = value
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
    this.payload = this._payload.join('')
    cb(null)
  }
}
