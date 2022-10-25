const createInject = require('./inject.js')

const isCompressedDefault = (ret) => {
  const contentEncoding = ret.headers['content-encoding']
  return contentEncoding && contentEncoding !== 'identity'
}

module.exports = (app, options) => {
  options = options || {}
  options.binaryMimeTypes = options.binaryMimeTypes || []
  options.serializeLambdaArguments = options.serializeLambdaArguments !== undefined ? options.serializeLambdaArguments : false
  options.decorateRequest = options.decorateRequest !== undefined ? options.decorateRequest : true
  options.enforceBase64 = typeof options.enforceBase64 === 'function' ? options.enforceBase64 : isCompressedDefault
  let currentAwsArguments = {}
  if (options.decorateRequest) {
    options.decorationPropertyName = options.decorationPropertyName || 'awsLambda'
    app.decorateRequest(options.decorationPropertyName, {
      getter: () => ({
        get event () {
          return currentAwsArguments.event
        },
        get context () {
          return currentAwsArguments.context
        }
      })
    })
  }

  const inject = createInject(app)

  return (event, context, callback) => {
    currentAwsArguments.event = event
    currentAwsArguments.context = context
    if (options.callbackWaitsForEmptyEventLoop !== undefined) {
      context.callbackWaitsForEmptyEventLoop = options.callbackWaitsForEmptyEventLoop
    }
    event.body = event.body || ''

    const method = event.httpMethod || (event.requestContext && event.requestContext.http ? event.requestContext.http.method : undefined)
    let url = event.path || event.rawPath || '/' // seen rawPath for HTTP-API
    // NOTE: if used directly via API Gateway domain and /stage
    if (event.requestContext && event.requestContext.stage && event.requestContext.resourcePath &&
        (url).indexOf(`/${event.requestContext.stage}/`) === 0 &&
        event.requestContext.resourcePath.indexOf(`/${event.requestContext.stage}/`) !== 0) {
      url = url.substring(event.requestContext.stage.length + 1)
    }
    const query = {}
    if (event.requestContext && event.requestContext.elb) {
      if (event.multiValueQueryStringParameters) {
        Object.keys(event.multiValueQueryStringParameters).forEach((q) => {
          query[decodeURIComponent(q)] = event.multiValueQueryStringParameters[q].map((val) => decodeURIComponent(val))
        })
      } else if (event.queryStringParameters) {
        Object.keys(event.queryStringParameters).forEach((q) => {
          query[decodeURIComponent(q)] = decodeURIComponent(event.queryStringParameters[q])
          if (event.version === '2.0' && typeof query[decodeURIComponent(q)] === 'string' && query[decodeURIComponent(q)].indexOf(',') > 0) {
            query[decodeURIComponent(q)] = query[decodeURIComponent(q)].split(',')
          }
        })
      }
    } else {
      if (event.queryStringParameters && event.version === '2.0') {
        Object.keys(event.queryStringParameters).forEach((k) => {
          if (typeof event.queryStringParameters[k] === 'string' && event.queryStringParameters[k].indexOf(',') > 0) {
            event.queryStringParameters[k] = event.queryStringParameters[k].split(',')
          }
        })
      }
      Object.assign(query, event.multiValueQueryStringParameters || event.queryStringParameters)
    }

    const headers = {}

    if (event.headers) {
      Object.keys(event.headers).forEach((h) => {
        headers[h.toLowerCase()] = event.headers[h]
      })
    }

    if (event.multiValueHeaders) {
      Object.keys(event.multiValueHeaders).forEach((h) => {
        if (event.multiValueHeaders[h].length > 1) {
          headers[h.toLowerCase()] = event.multiValueHeaders[h].join(',')
        }
      })
    }

    const body = event.body

    if (options.serializeLambdaArguments) {
      event.body = undefined // remove body from event only when setting request headers
      headers['x-apigateway-event'] = encodeURIComponent(JSON.stringify(event))
      if (context) headers['x-apigateway-context'] = encodeURIComponent(JSON.stringify(context))
    }

    if (event.requestContext && event.requestContext.requestId) {
      headers['x-request-id'] = headers['x-request-id'] || event.requestContext.requestId
    }

    // API gateway v2 cookies: https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html
    if (event.cookies && event.cookies.length) {
      headers['cookie'] = event.cookies.join(';')
    }

    const prom = new Promise((resolve) => {
      inject({
        method,
        url,
        query,
        body,
        enc: event.isBase64Encoded ? 'base64' : 'utf8',
        headers,
        version: event.version
      }, (err, res) => {
        if (err) {
          return resolve({
            statusCode: 500,
            body: '',
            headers: {}
          })
        }

        currentAwsArguments = {}

        const resHeaders = res.headers

        const headers = {}
        let multiValueHeaders
        let cookies
        resHeaders.forEach((header, key) => {
          let value = header.value
          const isArray = Array.isArray(value)

          if (key === 'set-cookie') {
            if (event.version === '2.0') {
              cookies = isArray ? value : [value]
              return true
            }

            if (isArray) {
              if (!multiValueHeaders) multiValueHeaders = {}
              multiValueHeaders['set-cookie'] = value
              return true
            }
          } else if (isArray) {
            value = value.join(',')
          }

          headers[key] = value
        })

        const ret = {
          statusCode: res.statusCode,
          headers,
          cookies,
          multiValueHeaders
        }

        const contentType = (ret.headers['content-type'] || '').split(';')[0]
        ret.isBase64Encoded = options.binaryMimeTypes.indexOf(contentType) > -1 || !!(options.enforceBase64(ret))
        ret.body = res.rawPayload(ret.isBase64Encoded)

        resolve(ret)
      })
    })

    if (!callback) return prom
    prom.then((ret) => callback(null, ret)).catch(callback)
    return prom
  }
}
