const {
  makeExecutableSchema,
  SchemaDirectiveVisitor
} = require('graphql-tools')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const json5 = require('json5')
const { GraphQLError } = require('graphql')
const { create: createUtils, getAppSyncConfig } = require('./util')
const { javaify, vtl } = require('./vtl')
const dynamodbSource = require('./dynamodbSource')
const lambdaSource = require('./lambdaSource')
const httpSource = require('./httpSource')
const elasticsearchSource = require('./elasticsearchSource')
const consola = require('./log')
const { inspect } = require('util')
const { scalars } = require('./schemaWrapper')
const DataLoader = require('dataloader')

const vtlMacros = {
  console: (...args) => {
    // eslint-disable-next-line no-console
    console.log(...args)
    return ''
  }
}

// eslint-disable-next-line
const gqlPathAsArray = path => {
  const flattened = []
  let curr = path
  while (curr) {
    flattened.push(curr.key)
    curr = curr.prev
  }
  return flattened.reverse()
}

class AppSyncError extends Error {
  constructor (errors = []) {
    super('aggregate errors')
    this.errors = errors
  }
}

// eslint-disable-next-line
const buildVTLContext = (
  { root, vars, context, info },
  result = null,
  stash = null
) => {
  const { jwt, request } = context
  const util = createUtils()
  const args = javaify(vars)
  const vtlRequest = request ? { headers: request.headers } : {}
  const vtlContext = {
    arguments: args,
    args,
    request: vtlRequest,
    identity: javaify({
      sub: jwt ? jwt.sub : null,
      issuer: jwt ? jwt.iss : null,
      username: jwt ? context.jwt['cognito:username'] : null,
      sourceIp: ['0.0.0.0'],
      defaultAuthStrategy: 'ALLOW',
      claims: context.jwt
    }),
    prev: result ? { result: javaify(result) } : undefined,
    source: root || {},
    result: javaify(result),
    stash: stash || javaify({})
  }
  return {
    util,
    utils: util,
    context: vtlContext,
    ctx: vtlContext
  }
}

const returnJSON = input => {
  try {
    // apparently appsync allows things like trailing commas.
    return json5.parse(input)
  } catch (err) {
    throw new Error(
      `Failed to parse the following VTL template as JSON:\n${input}\n${err.message}`
    )
  }
}

const handleSubstitutions = (str, subs = {}) => {
  return str.replace(/\$\{(\w+)\}/g, (match, p1) => {
    return subs[p1] ? subs[p1] : match
  })
}

const handleVTLRender = (
  str,
  context,
  // eslint-disable-next-line
  vtlMacros,
  { info: gqlInfo, context: gqlContext },
  config
) => {
  let templateOutput
  consola.debug(
    'Rendering with context\n',
    JSON.stringify(context.ctx, null, 2)
  )

  try {
    templateOutput = vtl(
      handleSubstitutions(str.toString(), config.substitutions),
      context,
      vtlMacros
    )
  } catch (err) {
    consola.error('Error rendering VTL\n', err.message)

    // only throw the template parsing error if we have not
    // set an error on context. This will ensure we abort the template
    // but return the correct error message.
    if (context.util.getErrors().length === 0) {
      throw err
    }
  }

  // check if we have any errors.
  const errors = context.util.getErrors()
  if (!errors.length) {
    return returnJSON(templateOutput)
  }
  // eslint-disable-next-line
  gqlContext.appsyncErrors = errors.map(error => {
    // XXX: Note we use a field other than "message" as it gets mutated
    // by the velocity engine breaking this logic.
    const { gqlMessage: message, errorType, data, errorInfo } = error
    const gqlErrorObj = new GraphQLError(
      message,
      gqlInfo.fieldNodes,
      null,
      null,
      gqlPathAsArray(gqlInfo.path)
    )
    Object.assign(gqlErrorObj, { errorType, data, errorInfo })
    return gqlErrorObj
  })

  consola.error('GraphQL Errors', gqlContext.appsyncErrors)
  throw gqlContext.appsyncErrors[0]
}

const runRequestVTL = (
  fullPath,
  graphqlInfo,
  result = null,
  stash = null,
  config
) => {
  consola.info('Loading request vtl', path.relative(process.cwd(), fullPath))

  const vtlContext = buildVTLContext(graphqlInfo, result, stash)
  const content = fs.readFileSync(fullPath, 'utf8')

  return [
    handleVTLRender(
      handleSubstitutions(content.toString(), config.substitutions),
      vtlContext,
      vtlMacros,
      graphqlInfo,
      config
    ),
    vtlContext.ctx.stash
  ]
}

const runResponseVTL = (fullPath, graphqlInfo, result, stash, config) => {
  consola.info('Loading response vtl', path.relative(process.cwd(), fullPath))
  const vtlContext = buildVTLContext(graphqlInfo, result, stash)
  const content = fs.readFileSync(fullPath, 'utf8')
  return handleVTLRender(
    content.toString(),
    vtlContext,
    vtlMacros,
    graphqlInfo,
    config
  )
}

const dispatchRequestToSource = async (
  source,
  { dynamodb, dynamodbTables, elastic, serverlessDirectory, serverlessConfig },
  request
) => {
  consola.info(
    'Dispatch to source',
    inspect({ name: source.name, type: source.type })
  )
  switch (source.type) {
    case 'AMAZON_DYNAMODB':
      return dynamodbSource(
        dynamodb,
        // default alias
        source.config.tableName,
        // mapping used for multi table operations.
        dynamodbTables,
        request
      )
    case 'AWS_LAMBDA':
      return lambdaSource(
        {
          serverlessDirectory,
          serverlessConfig,
          dynamodbEndpoint: dynamodb.endpoint.href,
          dynamodbTables
        },
        source.config.functionName,
        request
      )
    case 'AMAZON_ELASTICSEARCH':
      return elasticsearchSource(
        elastic.endpoint || source.config.endpoint,
        request
      )
    case 'HTTP':
      return httpSource(source.config.endpoint, request)
    case 'NONE':
      return request.payload
    default:
      throw new Error(`Cannot handle source type: ${source.type}`)
  }
}

const generateDataLoaderResolver = (source, configs) => {
  const batchLoaders = {}
  return fieldPath => {
    if (batchLoaders[fieldPath] === undefined) {
      batchLoaders[fieldPath] = new DataLoader(
        requests => {
          const batchRequest = requests[0]
          batchRequest.payload = requests.map(r => r.payload)
          consola.info(
            'Rendered Batch Request:\n',
            inspect(batchRequest, { depth: null, colors: true })
          )
          return dispatchRequestToSource(source, configs, batchRequest)
        },
        {
          shouldCache: false
        }
      )
    }

    return batchLoaders[fieldPath]
  }
}

const generateTypeResolver = (
  source,
  config,
  configs,
  { requestPath, responsePath, dataLoaderResolver },
  pipe = false
) => async (root, vars, context, info) => {
  try {
    const fieldPath = `${info.parentType}.${info.fieldName}`
    const pathInfo = gqlPathAsArray(info.path)
    consola.start(`Resolve: ${fieldPath} [${pathInfo}]`)

    assert(context && context.jwt, 'must have context.jwt')

    const resolverArgs = { root, vars, context, info }
    const [request, stash] = runRequestVTL(
      requestPath,
      resolverArgs,
      null,
      null,
      config
    )

    let requestResult
    if (request.operation === 'BatchInvoke') {
      const loader = dataLoaderResolver(fieldPath)
      requestResult = await loader.load(request)
    } else {
      consola.info(
        'Rendered Request:\n',
        inspect(request, { depth: null, colors: true })
      )
      requestResult = await dispatchRequestToSource(source, configs, request)
    }

    const response = runResponseVTL(
      responsePath,
      resolverArgs,
      requestResult,
      stash,
      config
    )
    consola.info(
      'Rendered Response:\n',
      inspect(response, { depth: null, colors: true })
    )
    // XXX: parentType probably is constructed with new String so == is required.
    // eslint-disable-next-line
    if (info.parentType == 'Mutation') {
      configs.pubsub.publish(info.fieldName, response)
    }
    return pipe ? { response, stash } : response
  } catch (err) {
    consola.error(`${info.parentType}.${info.fieldName} failed`)

    throw err
  }
}

const generatePipelineFunctionResolver = (
  source,
  config,
  configs,
  { requestPath, responsePath, dataLoaderResolver },
  pipe = false
) => async (root, vars, context, info, pipeResult = null, pipeStash = null) => {
  try {
    const fieldPath = `${info.parentType}.${info.fieldName}`
    const pathInfo = gqlPathAsArray(info.path)
    consola.start(`Resolve: ${fieldPath} [${pathInfo}]`)

    const resolverArgs = { root, vars, context, info }
    const [request, stash] = runRequestVTL(
      requestPath,
      resolverArgs,
      pipeResult,
      pipeStash,
      config
    )

    let requestResult
    if (request.operation === 'BatchInvoke') {
      const loader = dataLoaderResolver(fieldPath)
      requestResult = await loader.load(request)
    } else {
      consola.info(
        'Rendered Request:\n',
        inspect(request, { depth: null, colors: true })
      )
      requestResult = await dispatchRequestToSource(source, configs, request)
    }

    const response = runResponseVTL(
      responsePath,
      resolverArgs,
      requestResult,
      stash,
      config
    )
    consola.info(
      'Rendered Response:\n',
      inspect(response, { depth: null, colors: true })
    )
    // XXX: parentType probably is constructed with new String so == is required.
    // eslint-disable-next-line
    if (info.parentType == 'Mutation') {
      configs.pubsub.publish(info.fieldName, response)
    }
    return pipe ? { response, stash } : response
  } catch (err) {
    consola.error(`${info.parentType}.${info.fieldName} failed`)
    consola.error(err.errorMessage || err.message || err.stack || err)
    throw err
  }
}

const generatePipelineResolver = ({ before, after, functions, config }) => {
  return async (root, vars, context, info) => {
    const fieldPath = `${info.parentType}.${info.fieldName}`
    const pathInfo = gqlPathAsArray(info.path)
    consola.start(`Resolve: ${fieldPath} [${pathInfo}]`)
    assert(context && context.jwt, 'must have context.jwt')
    const resolverArgs = { root, vars, context, info }
    const [request, stash] = runRequestVTL(
      before,
      resolverArgs,
      null,
      null,
      config
    )

    let pipeResult
    let pipeStash = stash
    let pipePayload = null
    let pipeResponse
    // const pipeContext = vars
    for (const fn of functions) {
      pipeResult = await fn(root, vars, context, info, pipePayload, pipeStash)
      pipePayload = pipeResult.response
      pipeStash = pipeResult.stash
      pipeResponse = pipeResult.response
    }
    return pipeResponse
  }
}

const generateSubscriptionTypeResolver = (
  field,
  source,
  config,
  configs,
  { requestPath, responsePath }
) => {
  const subscriptionList = configs.subscriptions[field]
  if (!subscriptionList) {
    // no subscriptions found.
    return () => {}
  }

  const { mutations } = subscriptionList
  assert(
    mutations && mutations.length,
    `${field} must have aws_subscribe with mutations arg`
  )

  return {
    resolve: async (root, _, context, info) => {
      consola.start(
        `Resolve: ${info.parentType}.${info.fieldName} [${gqlPathAsArray(
          info.path
        )}]`
      )
      assert(context && context.jwt, 'must have context.jwt')
      // XXX: The below is what our templates expect but not 100% sure it's correct.
      // for subscriptions the "arguments" field is same as root here.
      const resolverArgs = { root, vars: root, context, info }
      const [request, stash] = runRequestVTL(
        requestPath,
        resolverArgs,
        null,
        null,
        config
      )
      const requestResult =
        (await dispatchRequestToSource(source, configs, request)) || {}

      consola.info(
        'Rendered Request:\n',
        inspect(requestResult, { depth: null, colors: true })
      )
      const response = runResponseVTL(
        responsePath,
        resolverArgs,
        requestResult,
        stash,
        config
      )
      consola.info(
        'Rendered Response:\n',
        inspect(response, { depth: null, colors: true })
      )
      return response
    },
    subscribe () {
      return configs.pubsub.asyncIterator(mutations)
    }
  }
}

const generatePathing = (
  dataSource,
  mappingTemplates,
  request,
  response,
  configs
) => ({
  requestPath: path.join(mappingTemplates, request),
  dataLoaderResolver: generateDataLoaderResolver(dataSource, configs),
  responsePath: path.join(mappingTemplates, response)
})

// const generateFunctionConfigurations = (
//   dataSources,
//   { functionConfigurations }
// ) => {
//   const preparedFunctions = []
//   // eslint-disable-next-line no-plusplus
//   for (let i = 0; i < functionConfigurations.length; ++i) {
//     // console.log(functionConfigurations[i])
//   }
//   return functionConfigurations
//   //return preparedFunctions
// }

const generateResolvers = (cwd, config, configs) => {
  const { mappingTemplatesLocation = 'mapping-templates' } = config
  const mappingTemplates = path.join(cwd, mappingTemplatesLocation)
  const dataSourceByName = config.dataSources.reduce(
    (sum, value) => ({
      ...sum,
      [value.name]: value
    }),
    {}
  )

  // const functionConfigurations = generateFunctionConfigurations(
  //   dataSourceByName,
  //   config
  // )

  return config.mappingTemplates.reduce(
    (sum, { dataSource, type, field, request, response, kind, functions }) => {
      // (sum, { dataSource, type, field, request, response, kind }) => {

      if (!sum[type]) {
        // eslint-disable-next-line
        sum[type] = {}
      }

      let resolver = {}
      if (kind && kind.toUpperCase() === 'PIPELINE') {
        const fns = functions.map(f => {
          const functionDef = config.functionConfigurations.find(
            ({ name }) => f == name
          )
          if (!functionDef) { throw new Error(`Pipeline function ${f} not defined`) }

          const source = dataSourceByName[functionDef.dataSource]
          const pathing = generatePathing(
            source,
            mappingTemplates,
            functionDef.request,
            functionDef.response,
            configs
          )

          return generatePipelineFunctionResolver(
            source,
            config,
            configs,
            pathing,
            true
          )
        })

        resolver = generatePipelineResolver({
          before: path.join(mappingTemplates, request),
          after: path.join(mappingTemplates, response),
          functions: fns,
          config
        })
      } else {
        const source = dataSourceByName[dataSource]
        const pathing = generatePathing(
          source,
          mappingTemplates,
          request,
          response,
          configs
        )

        resolver =
          type === 'subscription'
            ? generateSubscriptionTypeResolver(
              field,
              source,
              config,
              configs,
              pathing
            )
            : generateTypeResolver(source, config, configs, pathing)
      }

      return {
        ...sum,
        [type]: {
          ...sum[type],
          [field]: resolver
        }
      }
    },
    { ...scalars }
  )
}

const createSubscriptionsVisitor = () => {
  const subscriptions = {}
  class DirectiveVisitor extends SchemaDirectiveVisitor {
    visitFieldDefinition (field) {
      subscriptions[field.name] = this.args
    }
  }

  return {
    subscriptions,
    DirectiveVisitor
  }
}

const createSchema = async ({
  dynamodb,
  selectApi,
  dynamodbTables,
  elastic,
  graphqlSchema,
  serverlessDirectory,
  serverlessConfig,
  pubsub
} = {}) => {
  assert(dynamodb, 'must pass dynamodb')
  assert(
    dynamodbTables && typeof dynamodbTables === 'object',
    'must pass dynamodbTables'
  )
  assert(graphqlSchema, 'must pass graphql schema')
  assert(serverlessDirectory, 'must pass serverless dir')
  assert(serverlessConfig, 'must pass serverless config')
  assert(pubsub, 'must pass pubsub')

  const { subscriptions, DirectiveVisitor } = createSubscriptionsVisitor()
  const appSyncConfig = getAppSyncConfig(serverlessConfig, selectApi)

  // XXX: Below is a nice and easy hack.
  // walk the AST without saving the schema ... this is to capture subscription directives.
  makeExecutableSchema({
    typeDefs: graphqlSchema,
    schemaDirectives: {
      aws_subscribe: DirectiveVisitor
    },
    resolverValidationOptions: {
      requireResolversForResolveType: false
    }
  })

  const resolvers = await generateResolvers(
    serverlessDirectory,
    appSyncConfig,
    {
      dynamodb,
      dynamodbTables,
      elastic,
      pubsub,
      subscriptions,
      serverlessDirectory,
      serverlessConfig
    }
  )

  const schema = makeExecutableSchema({
    typeDefs: graphqlSchema,
    resolvers,
    schemaDirectives: {
      aws_subscribe: DirectiveVisitor
    },
    resolverValidationOptions: {
      requireResolversForResolveType: false
    }
  })

  const topics = Array.from(
    new Set(
      Object.values(subscriptions).reduce(
        (sum, { mutations }) => sum.concat(mutations),
        []
      )
    )
  )

  return {
    schema,
    topics,
    subscriptions
  }
}

module.exports = { createSchema, AppSyncError }
