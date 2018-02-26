import {
  IntrospectionInterfaceType,
  IntrospectionObjectType,
  IntrospectionScalarType,
  IntrospectionUnionType,
} from 'graphql'
import {
  IntrospectionField,
  IntrospectionQuery,
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
        `import { GraphQLResolveInfo, GraphQLScalarType } from 'graphql'`,
      )
    } else {
      this.importHeader.push(`import { GraphQLResolveInfo } from 'graphql'`)
    }

    this.allResolversInterface = [
      '',
      'export type Value<T> = T | Promise<T>',
      '/**',
      ' * The reason property is nullable even for non-null field is because we do not in the model',
      ' * whether the field is or possibly implemented by the resolver.',
      ' * If a resolve function is not given, then a default resolve behavior is used',
      ' * which takes the property of the source object of the same name as the field',
      " * and returns it as the Value, or if it's a function, returns the Value",
      ' * of calling that function while passing along args, context and info.',
      ' * NOTE how the function signature does not have parent',
      ' */',
      'export type GQLProperty<T, Args, Ctx> = Value<T | null> | ((args: Args, context: Ctx, info: GraphQLResolveInfo) => Value<T>)',
      '',
      'export type GQLResolver<T, P, Args, Ctx> = ((parent: P, args: Args, context: Ctx, info: GraphQLResolveInfo) => Value<T>)',
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
      `export interface AllResolvers {`,
    ]

    gqlTypes.forEach(type => {
      switch (type.kind) {
        case 'SCALAR':
          return this.generateCustomScalarResolver(type)

        case 'OBJECT':
          return this.generateObjectResolver(type, gqlTypes)

        case 'INTERFACE':
          this.generateObjectResolver(type, gqlTypes)
          return this.generateResolveTypeResolver(type)
        // TODO: Right now GraphQL implements interface info is lost in typescript
        // Should add typescript interface and add the relationship back in
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
    this.allResolversInterface.push(`${scalarType.name}?: GraphQLScalarType`)
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

    this.allResolversInterface.push(
      `${type.name}?: {  __resolveType: ${typeResolverName} }`,
    )
  }

  /**
   * e.g. type User { id: string }
   */
  private generateObjectResolver(
    gqlType: IntrospectionObjectType | IntrospectionInterfaceType,
    allGQLTypes: IntrospectionType[],
  ) {
    const extendTypes: string[] =
      gqlType.kind === 'OBJECT'
        ? gqlType.interfaces.map(i => `${i.name}<P>`)
        : []

    const extendGqlTypes = allGQLTypes.filter(
      t => extendTypes.indexOf(t.name) !== -1,
    ) as IntrospectionInterfaceType[]
    const extendFields = extendGqlTypes.reduce<string[]>(
      (prevFieldNames, extendGqlType) => {
        return prevFieldNames.concat(extendGqlType.fields.map(f => f.name))
      },
      [],
    )

    const typeResolverName = `${this.options.typePrefix}${gqlType.name}`
    const typeResolverBody: string[] = []
    const fieldResolversTypeDefs: string[] = []

    gqlType.fields.forEach(field => {
      if (
        extendFields.indexOf(field.name) !== -1 &&
        this.options.minimizeInterfaceImplementation
      ) {
        return
      }
      const res = this.generateObjectFieldResolver(gqlType, field)
      typeResolverBody.push(...res.typeResolverBody)
      fieldResolversTypeDefs.push(...res.fieldResolversTypeDefs)
    })

    const objectJsDoc = descriptionToJSDoc(gqlType)

    const possibleTypeNames: string[] = []
    const possibleTypeNamesMap: string[] = []
    if (gqlType.kind === 'INTERFACE') {
      possibleTypeNames.push(
        ...[
          '',
          `/** Use this to resolve interface type ${gqlType.name} */`,
          ...createTsUnionType(
            `Possible${gqlType.name}TypeNames`,
            gqlType.possibleTypes.map(pt => `'${pt.name}'`),
            this.options.typePrefix,
          ),
        ],
      )

      possibleTypeNamesMap.push(
        ...[
          '',
          `export interface ${this.options.typePrefix}${gqlType.name}NameMap {`,
          `${gqlType.name}: ${this.options.typePrefix}${gqlType.name}`,
          ...gqlType.possibleTypes.map(pt => {
            return `${pt.name}: ${this.options.typePrefix}${pt.name}`
          }),
          '}',
        ],
      )
    }

    const extendStr =
      extendTypes.length === 0
        ? ''
        : `extends ${extendTypes
            .map(t => this.options.typePrefix + t)
            .join(', ')} `

    this.resolverInterfaces.push(
      ...[
        '',
        `// MARK: --- ${typeResolverName}`,
        '',
        ...objectJsDoc,
        `export interface ${typeResolverName}<P = {}> ${extendStr}{`,
        ...typeResolverBody,
        '}',
        '',
        '',
        ...fieldResolversTypeDefs,
        ...possibleTypeNames,
        ...possibleTypeNamesMap,
      ],
    )

    // add the type resolver to resolver object
    if (gqlType.kind === 'OBJECT') {
      this.allResolversInterface.push(
        ...[`${gqlType.name}?: ${typeResolverName}`],
      )
    }
  }

  private generateObjectFieldResolver(
    objectType: IntrospectionObjectType | IntrospectionInterfaceType,
    field: IntrospectionField,
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
    const fieldResolverName = `${objectType.name}_${uppercaseFisrtFieldName}`

    const typeName = getModifiedTsTypeName(
      getTypeRef(field),
      this.options.typePrefix,
    )

    const fieldJsDocs = descriptionToJSDoc(field)

    fieldResolversTypeDefs.push(
      ...[
        ...fieldJsDocs,
        `export type ${fieldResolverName}<P> = GQLPropertyOrResolver<${typeName}, P, ${argsType}, ${
          this.contextType
        }>`,
      ],
    )

    typeResolverBody.push(...[`${field.name}?: ${fieldResolverName}<P>`])

    return { typeResolverBody, fieldResolversTypeDefs }
  }
}
