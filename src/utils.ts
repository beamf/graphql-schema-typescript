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
import { versionMajorMinor as TSVersion } from 'typescript'

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

/** Get the typescript name given GraphQL name */
export function getTsTypeName(
  gqlName: string,
  kind: string,
  typePrefix: string,
): string {
  if (kind === 'SCALAR') {
    return gqlScalarToTS(gqlName, typePrefix)
  }
  return `${typePrefix}${gqlName}`
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

export function getModifiedTsTypeName(ref: TypeRef, typePrefix: string) {
  const tsTypeName = getTsTypeName(ref.name, ref.kind, typePrefix)

  switch (ref.modifier) {
    case '': // User
      return `${tsTypeName} | null`

    case 'NON_NULL': // User!
      return `${tsTypeName}`

    case 'LIST': // [User]
      return `(${tsTypeName} | null)[] | null`

    case 'LIST NON_NULL': // [User!]
      return `${tsTypeName}[] | null`

    case 'NON_NULL LIST': // [User]!
      return `(${tsTypeName} | null)[]`

    case 'NON_NULL LIST NON_NULL': // [User!]!
      return `${tsTypeName}[]`

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
  ref: TypeRef,
  typePrefix: string,
): string {
  const modifiedTsTypeName = getModifiedTsTypeName(ref, typePrefix)
  switch (ref.modifier) {
    case '':
      return `${fieldName}?: ${modifiedTsTypeName}`

    case 'NON_NULL':
      return `${fieldName}: ${modifiedTsTypeName}`

    case 'LIST':
      return `${fieldName}?: ${modifiedTsTypeName}`

    case 'LIST NON_NULL':
      return `${fieldName}?: ${modifiedTsTypeName}`

    case 'NON_NULL LIST':
      return `${fieldName}: ${modifiedTsTypeName}`

    case 'NON_NULL LIST NON_NULL':
      return `${fieldName}: ${modifiedTsTypeName}`

    case 'LIST NON_NULL LIST NON_NULL':
      throw new Error('Theretically impossible type?') // return `${fieldName}?: ${modifiedTsTypeName}`

    case 'NON_NULL LIST NON_NULL LIST NON_NULL':
      throw new Error('Theretically impossible type?') // return `${fieldName}: ${modifiedTsTypeName}`

    // TODO: make it to handle any generic case
    default:
      throw new Error(
        `We are reaching the fieldModifier level that should not exists: ${
          ref.modifier
        }`,
      )
  }
}

/**
 * Create a union type e.g: type Color = 'Red' | 'Green' | 'Blue' | ...
 * Also, if the type is too long to fit in one line, split them info multiple lines
 * => type Color = 'Red'
 *      | 'Green'
 *      | 'Blue'
 *      | ...
 */
export function createTsUnionType(
  typeName: string,
  possibleTypes: string[],
  typePrefix: string,
): string[] {
  let result = `export type ${typePrefix}${typeName} = ${possibleTypes.join(
    ' | ',
  )};`
  if (result.length <= 80) {
    return [result]
  }

  let [firstLine, rest] = result.split('=')

  return [
    firstLine + '=',
    ...rest
      .replace(/ \| /g, ' |\n')
      .split('\n')
      .map(line => line.trim()),
  ]
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
      if (!trimmed.endsWith(' }') && !trimmed.endsWith(' };')) {
        indent -= tabSpaces
        if (indent < 0) {
          indent = 0
        }
      }
    }

    result.push(' '.repeat(indent) + line)

    if (trimmed.endsWith('{')) {
      indent += tabSpaces
    }
  }

  return result
}

export function isStringEnumSupported(): boolean {
  const [major, minor] = TSVersion.split('.').map(v => +v)
  return (major === 2 && minor >= 5) || major > 2
}
