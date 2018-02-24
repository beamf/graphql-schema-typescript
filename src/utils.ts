import * as fs from 'fs'
import {
  buildASTSchema,
  graphql,
  GraphQLSchema,
  IntrospectionField,
  IntrospectionInputValue,
  IntrospectionListTypeRef,
  IntrospectionNamedTypeRef,
  IntrospectionQuery,
  introspectionQuery,
  parse,
} from 'graphql'
import { join } from 'path'

/**
 * Send introspection query to a graphql schema
 */
export const introspectSchema = async (
  schema: GraphQLSchema,
): Promise<IntrospectionQuery> => {
  const { data, errors } = await graphql({
    schema: schema,
    source: introspectionQuery,
  })

  if (errors) {
    throw errors
  }

  return data as IntrospectionQuery
}

export function buildSchemaFromTypeDefs(schemaContents: string): GraphQLSchema {
  return buildASTSchema(parse(schemaContents))
}

function klawSync(path: string, filterRegex: RegExp, fileNames: string[] = []) {
  const fileStat = fs.statSync(path)
  if (fileStat.isDirectory()) {
    const directory = fs.readdirSync(path)
    directory.forEach(f => klawSync(join(path, f), filterRegex, fileNames))
  } else if (filterRegex.test(path)) {
    fileNames.push(path)
  }
  return fileNames
}

export const getSchemaContentViaLocalFile = (path: string): string => {
  const files = klawSync(path, /\.(graphql|gql)$/)
  const allTypeDefs = files
    .map(filePath => fs.readFileSync(filePath, 'utf-8'))
    .join('\n')
  return allTypeDefs
}

export interface SimpleTypeDescription {
  kind: string
  name: string
}
/**
 * Check if type is a built-in graphql type
 */
export const isBuiltinType = (type: SimpleTypeDescription): boolean => {
  const builtInScalarNames = ['Int', 'Float', 'String', 'Boolean', 'ID']
  const builtInEnumNames = ['__TypeKind', '__DirectiveLocation']
  const builtInObjectNames = [
    '__Schema',
    '__Type',
    '__Field',
    '__InputValue',
    '__Directive',
    '__EnumValue',
  ]

  return (
    (type.kind === 'SCALAR' && builtInScalarNames.indexOf(type.name) !== -1) ||
    (type.kind === 'ENUM' && builtInEnumNames.indexOf(type.name) !== -1) ||
    (type.kind === 'OBJECT' && builtInObjectNames.indexOf(type.name) !== -1)
  )
}

export interface GraphqlDescription {
  description?: string
  isDeprecated?: boolean
  deprecationReason?: string
}

/**
 * Convert description and deprecated directives into JSDoc
 */
export function descriptionToJSDoc(description: GraphqlDescription): string[] {
  let line = description.description || ''

  const { isDeprecated, deprecationReason } = description
  if (isDeprecated) {
    line += '\n@deprecated'
    if (deprecationReason) {
      line += ' ' + deprecationReason
    }
  }

  if (!line) {
    return []
  }

  const lines = line.split('\n').map(l => ' * ' + l)
  return ['/**', ...lines, ' */']
}

/** Reference to a specific type in GraphQL, possibly modified */
export interface TypeRef {
  modifier: string
  name: string
  kind: string
}
export function getTypeRef(
  field: IntrospectionField | IntrospectionInputValue,
): TypeRef {
  let modifier: string[] = []

  let typeRef = field.type

  while (typeRef.kind === 'NON_NULL' || typeRef.kind === 'LIST') {
    modifier.push(typeRef.kind)
    typeRef = (typeRef as IntrospectionListTypeRef).ofType!
  }

  return {
    modifier: modifier.join(' '),
    kind: (typeRef as IntrospectionNamedTypeRef).kind,
    name: (typeRef as IntrospectionNamedTypeRef).name,
  }
}

/** Get the typescript name given GraphQL name */
export function getTsName(
  gqlName: string,
  kind: string,
  typePrefix: string,
): string {
  if (kind === 'SCALAR') {
    return gqlScalarToTS(gqlName, typePrefix)
  }
  return `${typePrefix}${gqlName}`
}

export function getModifiedTsName(ref: TypeRef, typePrefix: string) {
  const refName = getTsName(ref.name, ref.kind, typePrefix)

  switch (ref.modifier) {
    case '': // User
      return `${refName} | null`

    case 'NON_NULL': // User!
      return `${refName}`

    case 'LIST': // [User]
      return `(${refName} | null)[] | null`

    case 'LIST NON_NULL': // [User!]
      return `${refName}[] | null`

    case 'NON_NULL LIST': // [User]!
      return `(${refName} | null)[]`

    case 'NON_NULL LIST NON_NULL': // [User!]!
      return `${refName}[]`

    case 'LIST NON_NULL LIST NON_NULL':
      throw new Error('Theretically impossible type?') // return `(${refName} | null)[][]`

    case 'NON_NULL LIST NON_NULL LIST NON_NULL':
      throw new Error('Theretically impossible type?') // return `${refName}[][]`

    // TODO: make it to handle any generic case
    default:
      throw new Error(
        `We are reaching the fieldModifier level that should not exists: ${
          ref.modifier
        }`,
      )
  }
}

export function createFieldRef(
  fieldName: string,
  refName: string,
  refModifier: string,
): string {
  switch (refModifier) {
    case '': {
      return `${fieldName}?: ${refName}`
    }

    case 'NON_NULL': {
      return `${fieldName}: ${refName}`
    }

    case 'LIST': {
      return `${fieldName}?: (${refName} | null)[]`
    }

    case 'LIST NON_NULL': {
      return `${fieldName}?: ${refName}[]`
    }

    case 'NON_NULL LIST': {
      return `${fieldName}: (${refName} | null)[]`
    }

    case 'NON_NULL LIST NON_NULL': {
      return `${fieldName}: ${refName}[]`
    }

    case 'LIST NON_NULL LIST NON_NULL': {
      return `${fieldName}?: ${refName}[][]`
    }

    case 'NON_NULL LIST NON_NULL LIST NON_NULL': {
      return `${fieldName}: ${refName}[][]`
    }

    // TODO: make it to handle any generic case

    default: {
      throw new Error(
        `We are reaching the fieldModifier level that should not exists: ${refModifier}`,
      )
    }
  }
}

export function gqlScalarToTS(scalarName: string, typePrefix: string): string {
  switch (scalarName) {
    case 'Int':
    case 'Float':
      return 'number'

    case 'String':
    case 'ID':
      return 'string'

    case 'Boolean':
      return 'boolean'

    default:
      return typePrefix + scalarName
  }
}

export const toUppercaseFirst = (value: string): string => {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export function formatTabSpace(lines: string[], tabSpaces: number): string[] {
  let result: string[] = []

  let indent = 0
  for (let line of lines) {
    const trimmed = line.trim()

    if (trimmed.endsWith('}') || trimmed.endsWith('};')) {
      indent -= tabSpaces
      if (indent < 0) {
        indent = 0
      }
    }

    result.push(' '.repeat(indent) + line)

    if (trimmed.endsWith('{')) {
      indent += tabSpaces
    }
  }

  return result
}
