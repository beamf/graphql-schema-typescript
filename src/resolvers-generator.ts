import {
  IntrospectionInterfaceType,
  IntrospectionObjectType,
  IntrospectionScalarType,
  IntrospectionUnionType,
} from 'graphql'
import {
  IntrospectionField,
  IntrospectionQuery,
  IntrospectionSchema,
  IntrospectionType,
} from 'graphql/utilities/introspectionQuery'

import { GenerateTypescriptOptions } from './options'
import {
  createFieldRef,
  createTsUnionType,
  descriptionToJSDoc,
  getModifiedTsTypeName,
  getTypeRef,
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
export class ResolversGenerator {
  protected importHeader: string[] = []
  protected resolverMapInterface: string[] = []
  protected resolverInterfaces: string[] = []
  protected contextType: string
  protected rootValueType: string

  constructor(protected options: GenerateTypescriptOptions) {
    if (options.resolver) {
      this.contextType = options.resolver.contextType
      this.rootValueType = options.resolver.rootValueType
      if (options.resolver.headerStatements) {
        this.importHeader.push(options.resolver.headerStatements)
      }
    }
    if (!this.contextType || this.contextType === 'any') {
      this.contextType = 'Context'
      this.importHeader.push('export type Context = any')
    }

    if (!this.rootValueType || this.rootValueType === 'any') {
      this.rootValueType = 'RootValue'
      this.importHeader.push('export type RootValue = any')
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
        `import { GraphQLResolveInfo, GraphQLScalarType } from 'graphql'`,
      )
    } else {
      this.importHeader.push(`import { GraphQLResolveInfo } from 'graphql'`)
    }

    this.resolverMapInterface = [
      '',
      '/**',
      ' * Technically a property can be a function also. We DO NOT support this use case',
      ' * because it does not feel like a good coding pattern to put resolver-like functions',
      ' * on to of the object itself. If needed, property with getter can be used',
      ' * which takes the property of the source object of the same name as the field',
      " * and returns it as the Value, or if it's a function, returns the Value",
      ' * of calling that function while passing along args, context and info.',
      ' * NOTE how the function signature does not have parent',
      ' */',
      'export type GQLProperty<T, Args, Ctx> = T | Promise<T> // | ((args: Args, context: Ctx, info: GraphQLResolveInfo) => T | Promise<T>)',
      '',
      'export type GQLResolver<T, P, Args, Ctx> = (parent: P, args: Args, context: Ctx, info: GraphQLResolveInfo) => T | Promise<T>',
      '/**',
      ' * When used as properties of the return value of an existing resolver, this really should be',
      ' * Value<T> instead -> So resolvers should not be returning other resolver-like objects',
      ' * In practice the implementation "sort of" allows it (see above)',
      ' * TODO: Finish correct type def for model separate from resolver',
      ' */',
      'export type GQLPropertyOrResolver<T, P, Args, Ctx> = GQLProperty<T, Args, Ctx> | GQLResolver<T, P, Args, Ctx>',
      '',
      'export type GQLTypeResolver<P, Ctx, T> = ',
      '  (parent: P, context: Ctx, info: GraphQLResolveInfo) => T',
      '/**',
      ' * This interface define the shape of your resolver',
      ' * Note that this type is designed to be compatible with graphql-tools resolvers',
      ' * However, you can still use other generated interfaces to make your resolver type-safed',
      ' */',
      `export interface ResolverMap {`,
    ]

    const schema = introspectionResult.__schema
    const rootTypeNames = [
      schema.queryType.name,
      schema.mutationType && schema.mutationType.name,
      schema.subscriptionType && schema.subscriptionType.name,
    ].filter(n => n != null)

    gqlTypes.forEach(type => {
      switch (type.kind) {
        case 'SCALAR':
          return this.generateCustomScalarResolver(type)

        case 'OBJECT':
          // this.generateObjectModel(type, gqlTypes)
          return this.generateObjectResolver(type, gqlTypes, rootTypeNames)

        case 'INTERFACE':
          this.generateObjectResolver(type, gqlTypes, rootTypeNames)
          return this.generateResolveTypeResolver(type)
        // TODO: Right now GraphQL implements interface info is lost in typescript
        // Should add typescript interface and add the relationship back in
        case 'UNION':
          return this.generateResolveTypeResolver(type)
      }
    })

    this.resolverMapInterface.push('}')

    return {
      importHeader: this.importHeader,
      body: [...this.resolverMapInterface, ...this.resolverInterfaces],
    }
  }

  /**
   * e.g. Json
   */
  private generateCustomScalarResolver(scalarType: IntrospectionScalarType) {
    this.resolverMapInterface.push(`${scalarType.name}?: GraphQLScalarType`)
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
        `export type ${typeResolverName}<P = {}> = GQLTypeResolver<P, ${
          this.contextType
        }, ${possbileTypes.join(' | ')}>`,
      ],
    )

    this.resolverMapInterface.push(
      `${type.name}?: {  __resolveType: ${typeResolverName} }`,
    )
  }

  /**
   * e.g. type User { id: string }
   */
  private generateObjectResolver(
    gqlType: IntrospectionObjectType | IntrospectionInterfaceType,
    allGQLTypes: IntrospectionType[],
    rootTypeNames: string[],
  ) {
    const extendTypes: string[] =
      gqlType.kind === 'OBJECT' ? gqlType.interfaces.map(i => i.name) : []

    const extendGqlTypes = allGQLTypes.filter(
      t => extendTypes.indexOf(t.name) !== -1,
    ) as IntrospectionInterfaceType[]
    const extendFields = extendGqlTypes.reduce<string[]>(
      (prevFieldNames, extendGqlType) => {
        return prevFieldNames.concat(extendGqlType.fields.map(f => f.name))
      },
      [],
    )

    const isRootType = rootTypeNames.indexOf(gqlType.name) !== -1

    const typeName = isRootType ? this.rootValueType : `${this.options.typePrefix}${gqlType.name}`
    const typeResolversName = `${this.options.typePrefix}${gqlType.name}Resolvers`
    const typeResolverBody: string[] = []
    const fieldResolversTypeDefs: string[] = []

    gqlType.fields.forEach(field => {
      if (
        extendFields.indexOf(field.name) !== -1 &&
        this.options.minimizeInterfaceImplementation
      ) {
        return
      }
      const res = this.generateObjectFieldResolver(gqlType, field, typeName)
      typeResolverBody.push(...res.typeResolverBody)
      fieldResolversTypeDefs.push(...res.fieldResolversTypeDefs)
    })

    const objectJsDoc = descriptionToJSDoc(gqlType)

    const extendStr =
      extendTypes.length === 0
        ? ''
        : `extends ${extendTypes
            .map(t => `${this.options.typePrefix}${t}Resolvers<P>`)
            .join(', ')} `

    this.resolverInterfaces.push(
      ...[
        '',
        `// MARK: --- ${typeResolversName}`,
        '',
        ...objectJsDoc,
        `export interface ${typeResolversName}<P = ${typeName}> ${extendStr}{`,
        ...typeResolverBody,
        '}',
        '',
        '',
        ...fieldResolversTypeDefs,
      ],
    )

    // add the type resolver to resolver object
    if (gqlType.kind === 'OBJECT') {
      // NOTE: Technically this does not let consumer override the resolver parent type
      // with custom type. However will sufficient for now.
      this.resolverMapInterface.push(
        ...[`${gqlType.name}?: ${typeResolversName}`],
      )
    }
  }

  private generateObjectFieldResolver(
    objectType: IntrospectionObjectType | IntrospectionInterfaceType,
    field: IntrospectionField,
    parentTypeName: string,
  ) {
    const typeResolverBody: string[] = []
    const fieldResolversTypeDefs: string[] = []

    // generate args type
    let argsType = '{}'

    const uppercaseFisrtFieldName = toUppercaseFirst(field.name)

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
    }_${uppercaseFisrtFieldName}_Resolver`

    const typeName = getModifiedTsTypeName(
      getTypeRef(field),
      this.options.typePrefix,
    )

    const fieldJsDocs = descriptionToJSDoc(field)

    fieldResolversTypeDefs.push(
      ...[
        ...fieldJsDocs,
        `export type ${fieldResolverName}<P = ${parentTypeName}> = GQLResolver<${typeName}, P, ${argsType}, ${
          this.contextType
        }>`,
      ],
    )

    typeResolverBody.push(...[`${field.name}?: ${fieldResolverName}<P>`])

    return { typeResolverBody, fieldResolversTypeDefs }
  }
}
