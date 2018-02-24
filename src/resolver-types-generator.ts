import {
  IntrospectionInterfaceType,
  IntrospectionObjectType,
  IntrospectionScalarType,
  IntrospectionUnionType,
} from 'graphql'
import {
  IntrospectionField,
  IntrospectionListTypeRef,
  IntrospectionNamedTypeRef,
  IntrospectionNonNullTypeRef,
  IntrospectionQuery,
  IntrospectionTypeRef,
} from 'graphql/utilities/introspectionQuery'

import { GenerateTypescriptOptions } from './options'
import {
  createFieldRef,
  descriptionToJSDoc,
  getModifiedTsTypeName,
  getTypeRef,
  gqlScalarToTS,
  isBuiltinType,
  toUppercaseFirst,
} from './utils'

export interface GenerateResolversResult {
  importHeader: string[]
  body: string[]
}

/**
 * Generate object, interface and union, plus scalar resolvers
 */
export class ResolverTypesGenerator {
  protected importHeader: string[] = []
  protected allResolversInterface: string[] = []
  protected resolverInterfaces: string[] = []
  protected contextType: string

  constructor(protected options: GenerateTypescriptOptions) {
    if (options.resolver) {
      this.contextType = options.resolver.contextType
      if (options.resolver.importContext) {
        this.importHeader.push(options.resolver.importContext)
      }
    } else {
      this.contextType = 'any'
    }
  }

  public async generate(
    introspectionResult: IntrospectionQuery,
  ): Promise<GenerateResolversResult> {
    const gqlTypes = introspectionResult.__schema.types.filter(
      type => !isBuiltinType(type),
    )

    const hasCustomScalar = !!gqlTypes.find(type => type.kind === 'SCALAR')
    if (hasCustomScalar) {
      this.importHeader.push(
        `import { GraphQLResolveInfo, GraphQLScalarType } from 'graphql';`,
      )
    } else {
      this.importHeader.push(`import { GraphQLResolveInfo } from 'graphql';`)
    }

    this.allResolversInterface = [
      '',
      'export type Result<T> = T | null | Promise<T | null>',
      'export type GQLField<T, P, Args, Ctx> =',
      ' | Result<T>',
      ' | ((parent: P, args: Args, context: Ctx, info: GraphQLResolveInfo) => Result<T>)',
      '',
      'export type GQLTypeResolver<P, Ctx, T> = ',
      '  (parent: P, context: Ctx, info: GraphQLResolveInfo) => T',
      '/**',
      ' * This interface define the shape of your resolver',
      ' * Note that this type is designed to be compatible with graphql-tools resolvers',
      ' * However, you can still use other generated interfaces to make your resolver type-safed',
      ' */',
      `export interface AllResolvers {`,
    ]

    gqlTypes.forEach(type => {
      switch (type.kind) {
        case 'SCALAR':
          return this.generateCustomScalarResolver(type)

        case 'OBJECT':
          return this.generateObjectResolver(type)

        case 'INTERFACE':
        case 'UNION':
          return this.generateResolveTypeResolver(type)
      }
    })

    this.allResolversInterface.push('}')

    return {
      importHeader: this.importHeader,
      body: [...this.allResolversInterface, ...this.resolverInterfaces],
    }
  }

  /**
   * e.g. Json
   */
  private generateCustomScalarResolver(scalarType: IntrospectionScalarType) {
    this.allResolversInterface.push(`${scalarType.name}?: GraphQLScalarType;`)
  }

  /**
   * Resolving union / interface `__resolveType` function def.
   * e.g. union Searchable = Movie | User
   */
  private generateResolveTypeResolver(
    type: IntrospectionUnionType | IntrospectionInterfaceType,
  ) {
    const possbileTypes = type.possibleTypes.map(pt => `'${pt.name}'`)
    const typeResolverName = `${this.options.typePrefix}${
      type.name
    }_TypeResolver`

    this.resolverInterfaces.push(
      ...[
        '',
        `// MARK: --- ${typeResolverName}`,
        '',
        `export type ${typeResolverName}<P = any> = GQLTypeResolver<P, ${
          this.contextType
        }, ${possbileTypes.join(' | ')}>`,
      ],
    )

    this.allResolversInterface.push(
      `${type.name}?: {  __resolveType: ${typeResolverName} }`,
    )
  }

  /**
   * e.g. type User { id: string }
   */
  private generateObjectResolver(objectType: IntrospectionObjectType) {
    const typeResolverName = `${this.options.typePrefix}${objectType.name}`
    const typeResolverBody: string[] = []
    const fieldResolversTypeDefs: string[] = []

    objectType.fields.forEach(field => {
      const res = this.generateObjectFieldResolver(objectType, field)
      typeResolverBody.push(...res.typeResolverBody)
      fieldResolversTypeDefs.push(...res.fieldResolversTypeDefs)
    })

    const objectJsDoc = descriptionToJSDoc(objectType)

    this.resolverInterfaces.push(
      ...[
        '',
        `// MARK: --- ${typeResolverName}`,
        '',
        ...objectJsDoc,
        `export interface ${typeResolverName}<P = any> {`,
        ...typeResolverBody,
        '}',
        '',
        '',
        ...fieldResolversTypeDefs,
      ],
    )

    // add the type resolver to resolver object
    this.allResolversInterface.push(
      ...[`${objectType.name}?: ${typeResolverName};`],
    )
  }

  private generateObjectFieldResolver(
    objectType: IntrospectionObjectType,
    field: IntrospectionField,
  ) {
    const typeResolverBody: string[] = []
    const fieldResolversTypeDefs: string[] = []

    // generate args type
    let argsType = '{}'

    let uppercaseFisrtFieldName = toUppercaseFirst(field.name)

    if (field.args.length > 0) {
      argsType = `${objectType.name}_${uppercaseFisrtFieldName}_Args`

      const argsBody = field.args.reduce((body: string[], arg) => {
        return body.concat(
          createFieldRef(arg.name, getTypeRef(arg), this.options.typePrefix),
        )
      }, [])

      const argsTypeDefs = [
        `export interface ${argsType} {`,
        argsBody.join(', '),
        '}',
      ].join(' ')

      fieldResolversTypeDefs.push('', argsTypeDefs)
    }

    // generate field type
    const fieldResolverName = `${
      objectType.name
    }_${uppercaseFisrtFieldName}_Field`

    const typeName = getModifiedTsTypeName(
      getTypeRef(field),
      this.options.typePrefix,
    )

    const fieldJsDocs = descriptionToJSDoc(field)

    fieldResolversTypeDefs.push(
      ...[
        ...fieldJsDocs,
        `export type ${fieldResolverName}<P> = GQLField<${typeName}, P, ${argsType}, ${
          this.contextType
        }>`,
      ],
    )

    typeResolverBody.push(...[`${field.name}?: ${fieldResolverName}<P>`])

    return { typeResolverBody, fieldResolversTypeDefs }
  }
}
