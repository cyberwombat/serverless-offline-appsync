const { toJSON } = require('./vtl')
const log = require('./log')
const getTime = require('date-fns/getTime')
const fromUnixTime = require('date-fns/fromUnixTime')
const formatISO = require('date-fns/formatISO')
const format = require('date-fns/format')
const parseISO = require('date-fns/parseISO')
const toDate = require('date-fns/toDate')

class Unauthorized extends Error {}
class TemplateSentError extends Error {
  constructor (gqlMessage, errorType, data, errorInfo) {
    super(gqlMessage)
    Object.assign(this, { gqlMessage, errorType, data, errorInfo })
  }
}
class ValidateError extends Error {
  constructor (gqlMessage, type, data) {
    super(gqlMessage)
    Object.assign(this, { gqlMessage, type, data })
  }
}

const create = (errors = [], now = new Date()) => ({
  quiet: () => '',
  qr: () => '',
  escapeJavaScript (value) {
    return require('js-string-escape')(value)
  },
  urlEncode (value) {
    return encodeURI(value)
  },
  urlDecode (value) {
    return decodeURI(value)
  },
  base64Encode (value) {
    // eslint-disable-next-line
    return new Buffer(value).toString('base64')
  },
  base64Decode (value) {
    // eslint-disable-next-line
    return new Buffer(value, 'base64').toString('ascii')
  },
  parseJson (value) {
    return JSON.parse(value)
  },
  toJson (value) {
    return JSON.stringify(value)
  },
  autoId () {
    return require('uuid').v4()
  },
  unauthorized () {
    const err = new Unauthorized('Unauthorized')
    errors.push(err)
    throw err
  },
  error (message, type = null, data = null, errorInfo = null) {
    const err = new TemplateSentError(message, type, data, errorInfo)
    errors.push(err)
    throw err
  },
  appendError (message, type = null, data = null, errorInfo = null) {
    errors.push(new TemplateSentError(message, type, data, errorInfo))
    return ''
  },
  getErrors () {
    return errors
  },
  validate (allGood, message, type, data) {
    if (allGood) return ''
    throw new ValidateError(message, type, data)
  },
  isNull (value) {
    return value === null
  },
  isNullOrEmpty (value) {
    return !value || !value.toString().length
  },
  isNullOrBlank (value) {
    return !value || !!value.toString().match(/^\s*$/)
  },
  defaultIfNull (value, defaultValue) {
    if (value !== null && value !== undefined) return value
    return defaultValue
  },
  defaultIfNullOrEmpty (value, defaultValue) {
    if (value) return value
    return defaultValue
  },
  defaultIfNullOrBlank (value, defaultValue) {
    if (value) return value
    return defaultValue
  },
  isString (value) {
    return typeof value === 'string'
  },
  isNumber (value) {
    return typeof value === 'number'
  },
  isBoolean (value) {
    return typeof value === 'boolean'
  },
  isList (value) {
    return Array.isArray(value)
  },
  isMap (value) {
    if (value instanceof Map) return value
    return value != null && typeof value === 'object'
  },
  typeOf (value) {
    if (value === null) return 'Null'
    if (this.isList(value)) return 'List'
    if (this.isMap(value)) return 'Map'
    switch (typeof value) {
      case 'number':
        return 'Number'
      case 'string':
        return 'String'
      case 'boolean':
        return 'Boolean'
      default:
        return 'Object'
    }
  },
  matches (pattern, value) {
    return new RegExp(pattern).test(value)
  },
  time: {
    nowISO8601 () {
      return now.toISOString()
    },
    nowEpochSeconds () {
      return parseInt(now.valueOf() / 1000, 10)
    },
    nowEpochMilliSeconds () {
      return now.valueOf()
    },
    nowFormatted (format, timezone = null) {
      if (timezone) throw new Error('no support for setting timezone!')
      return require('dateformat')(now, format)
    },
    parseFormattedToEpochMilliSeconds () {
      throw new Error('not implemented')
    },
    parseISO8601ToEpochMilliSeconds (date) {
      return getTime(new Date(date))
    },
    epochMilliSecondsToSeconds (stamp) {
      return String(stamp).slice(0, -3)
    },
    epochMilliSecondsToISO8601 (stamp) {
      return formatISO(fromUnixTime(String(stamp).slice(0, 10)))
    },
    // TODO - need to address diffs between date-fns and java date
    epochMilliSecondsToFormatted (stamp, pattern) {
      pattern = pattern.replace('Z', "'Z'")
      pattern = pattern.replace('T', "'T'")

      try {
        return format(toDate(stamp), pattern)
      } catch (e) {
        console.log(e)
      }
    }
  },
  list: {
    copyAndRetainAll (list, intersect) {
      return list.filter(value => intersect.indexOf(value) !== -1)
    },
    copyAndRemoveAll (list, toRemove) {
      return list.filter(value => toRemove.indexOf(value) === -1)
    }
  },
  map: {
    copyAndRetainAllKeys (map, keys = []) {
      // JavaMap - TODO - check if instance next time we get around to it
      if (map.map) {
        map.map.forEach((value, key, map) => {
          if (!~keys.indexOf(key)) {
            map.delete(key)
          }
        })
        return map
      } else {
        for (const key of keys) {
          if (!~keys.indexOf(key)) {
            delete map[key]
          }
        }
        return map
      }
    },
    copyAndRemoveAllKeys (map, keys = []) {
      // JavaMap - TODO - check if instance next time we get around to it
      if (map.map) {
        for (const key of keys) {
          map.map.delete(key)
        }

        return map
      } else {
        for (const key of keys) {
          delete map[key]
        }
        return map
      }
    }
  },
  dynamodb: {
    toDynamoDB (value) {
      const {
        DynamoDB: { Converter }
      } = require('aws-sdk')
      return Converter.input(toJSON(value))
    },
    $toSet (values, fn = value => value) {
      // const DynamoDBSet = require('aws-sdk/lib/dynamodb/set')
      const DynamoDB = require('aws-sdk/clients/dynamodb')
      const { DocumentClient } = DynamoDB
      var documentClient = new DocumentClient()
      return documentClient.createSet([].concat(values).map(value => fn(value)))

      // return this.toDynamoDB(
      //   new DynamoDBSet([].concat(values).map(value => fn(value)))
      // )
    },
    toDynamoDBJson (value) {
      return JSON.stringify(this.toDynamoDB(value))
    },
    toString (value) {
      return this.toDynamoDB(String(value))
    },
    toStringJson (value) {
      return this.toDynamoDBJson(value)
    },
    toStringSet (value) {
      return { SS: this.$toSet(value, String) }
    },
    toStringSetJson (value) {
      return JSON.stringify(this.toStringSet(value))
    },
    toNumber (value) {
      return this.toDynamoDB(Number(value))
    },
    toNumberJson (value) {
      return JSON.stringify(this.toNumber(value))
    },
    toNumberSet (value) {
      return { NS: this.$toSet(value, Number) }
    },
    toNumberSetJson (value) {
      return JSON.stringify(this.toNumberSet(value))
    },
    toBinary (value) {
      return { B: toJSON(value) }
    },
    toBinaryJson (value) {
      // this is probably wrong.
      return JSON.stringify(this.toBinary(value))
    },
    toBinarySet (value) {
      return { BS: [].concat(value) }
    },
    toBinarySetJson (value) {
      return JSON.stringify(this.toBinarySet(value))
    },
    toBoolean (value) {
      return { BOOL: value }
    },
    toBooleanJson (value) {
      return JSON.stringify(this.toBoolean(value))
    },
    toNull () {
      return { NULL: null }
    },
    toNullJson () {
      return JSON.stringify(this.toNull())
    },
    toList (value) {
      return this.toDynamoDB(value)
    },
    toListJson (value) {
      return JSON.stringify(this.toList(value))
    },
    toMap (value) {
      // this should probably do some kind of conversion.
      return this.toDynamoDB(toJSON(value))
    },
    toMapJson (value) {
      return JSON.stringify(this.toMap(value))
    },
    toMapValues (values) {
      return Object.entries(toJSON(values)).reduce(
        (sum, [key, value]) => ({
          ...sum,
          [key]: this.toDynamoDB(value)
        }),
        {}
      )
    },
    toMapValuesJson (values) {
      return JSON.stringify(this.toMapValues(values))
    },
    toS3ObjectJson () {
      throw new Error('not implemented')
    },
    toS3Object () {
      throw new Error('not implemented')
    },
    fromS3ObjectJson () {
      throw new Error('not implemented')
    }
  }
})

const getAppSyncConfig = (cfConfig, apiName) => {
  const { custom: { appSync: appSyncConfig } = {} } = cfConfig

  if (!Array.isArray(appSyncConfig)) {
    return appSyncConfig
  }

  if (!apiName) { throw new Error('Multiple API\'s provided but no preferred API defined') }

  const api = appSyncConfig.find(({ name }) => name === apiName)
  if (!api) throw new Error(`API ${name} not found`)
  return api
}

const flatten = arr =>
  arr.reduce((acc, curr) => {
    if (Array.isArray(curr)) {
      return [...acc, ...flatten(curr)]
    }
    return [...acc, curr]
  }, [])

const flatteningMappingTemplatesAndDataSources = appSync => {
  // eslint-disable-next-line
  appSync.mappingTemplates =
    typeof appSync.mappingTemplates !== 'undefined'
      ? flatten(appSync.mappingTemplates)
      : []
  // eslint-disable-next-line
  appSync.dataSources =
    typeof appSync.dataSources !== 'undefined'
      ? flatten(appSync.dataSources)
      : []
}

module.exports = {
  create,
  TemplateSentError,
  Unauthorized,
  ValidateError,
  getAppSyncConfig,
  flatteningMappingTemplatesAndDataSources
}
