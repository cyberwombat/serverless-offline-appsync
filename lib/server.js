const path = require('path')
const pkgUp = require('pkg-up')
const { loadServerlessConfig } = require('./loadServerlessConfig')
const { PubSub } = require('graphql-subscriptions')
const fs = require('fs')
const { createSchema: createSchemaCore } = require('./schema')
const createServerCore = require('./serverCore')

const { wrapSchema } = require('./schemaWrapper')
const { cloudFormationProcessor } = require('./cloudFormationProcessor')
const {
  getAppSyncConfig,
  flatteningMappingTemplatesAndDataSources
} = require('./util')

const findServerlessPath = ({ parent: { filename } } = module) =>
  path.dirname(pkgUp.sync(filename))

const ensureDynamodbTables = async (
  dynamodb,
  serverlessConfig,
  appSyncConfig
) => {
  const { dataSources } = appSyncConfig
  const { resources: { Resources: resources = {} } = {} } = serverlessConfig

  await Promise.all(
    Object.values(resources)
      .filter(resource => resource.Type === 'AWS::DynamoDB::Table')
      .map(async resource => {
        const { Properties } = resource
        try {
          // Remove TTL ass it will break this function
          delete Properties.TimeToLiveSpecification

          // log.info('creating table', params)
          await dynamodb.createTable(Properties).promise()
        } catch (err) {
          if (err.code !== 'ResourceInUseException') throw err
        }
      })
  )

  return dataSources
    .filter(source => source.type === 'AMAZON_DYNAMODB')
    .reduce(
      (sum, source) => ({
        ...sum,
        [source.config.tableName]: source.config.tableName
      }),
      {}
    )
}

const createSchema = async ({
  serverless,
  selectApi = null,
  pubsub,
  elastic,
  dynamodb,
  ...otherOpts
} = {}) => {
  let serverlessConfig = {}
  let serverlessDirectory
  if (typeof serverless === 'object') {
    serverlessConfig = serverless.service
    const appSyncConfig = getAppSyncConfig(serverlessConfig, selectApi)
    flatteningMappingTemplatesAndDataSources(appSyncConfig)
    serverlessConfig.appSyncConfig = appSyncConfig
    serverlessDirectory = serverless.config.servicePath
  } else {
    serverlessDirectory =
      typeof serverless === 'string'
        ? path.dirname(serverless)
        : findServerlessPath()
    const config = await loadServerlessConfig(serverlessDirectory)
    serverlessConfig = config.config
  }

  if (otherOpts.bootstrapScript) { require(path.join(serverlessDirectory, otherOpts.bootstrapScript)) }

  const cfConfig = cloudFormationProcessor(serverlessConfig, {
    // we do not use aliases for the dynamodb tables in server like we do in testing.
    dynamodbTables: {}
  })

  const appSyncConfig = getAppSyncConfig(cfConfig, selectApi)

  const filePaths = Array.isArray(appSyncConfig.schema)
    ? appSyncConfig.schema
    : [appSyncConfig.schema]
  const schemaData = filePaths
    .map(file => {
      if (!fs.existsSync(file)) { throw new Error(`schema file: ${file} must exist`) }
      return fs.readFileSync(file, 'utf8')
    })
    .join('\n')
  const graphqlSchema = wrapSchema(schemaData, 'utf8')

  const dynamodbTables = await ensureDynamodbTables(
    dynamodb,
    cfConfig,
    appSyncConfig
  )

  return createSchemaCore({
    dynamodb,
    selectApi,
    dynamodbTables,
    elastic,
    graphqlSchema,
    serverlessDirectory,
    serverlessConfig: cfConfig,
    pubsub
  })
}

const createServer = async ({
  wsPort,
  port,
  dynamodb,
  elastic,
  ...createSchemaOpts
}) => {
  const pubsub = new PubSub()
  const { schema, subscriptions } = await createSchema({
    ...createSchemaOpts,
    dynamodb,
    elastic,
    pubsub
  })

  return createServerCore({
    wsPort,
    port,
    pubsub,
    schema,
    subscriptions
  })
}

module.exports = createServer
