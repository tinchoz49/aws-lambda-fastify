const fastify = require('fastify')
const awsLambdaFastify = require('./index')

const app = fastify()
const evt = {
  version: '2.0',
  httpMethod: 'GET',
  path: '/test',
  headers: {
    'X-My-Header': 'wuuusaaa'
  },
  cookies: ['foo=bar'],
  queryStringParameters: ''
}
app.get('/test', async (request, reply) => {
  reply.header('Set-Cookie', 'qwerty=one')
  reply.header('Set-Cookie', 'qwerty=two')
  reply.send({ hello: 'world' })
})

;(async () => {
  const proxy = awsLambdaFastify(app, { serializeLambdaArguments: true })
  const ret = await proxy(evt)
  console.log(ret)
})()
