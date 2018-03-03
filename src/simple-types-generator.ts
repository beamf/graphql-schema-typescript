import {
  IntrospectionEnumType,
  IntrospectionField,
  IntrospectionInputObjectType,
  IntrospectionInterfaceType,
  IntrospectionObjectType,
  IntrospectionQuery,
  IntrospectionScalarType,
  IntrospectionType,
  IntrospectionUnionType,
} from 'graphql'

import { GenerateTypescriptOptions } from './options'
import {
  createFieldRef,
  createTsUnionType,
  descriptionToJSDoc,
  getModifiedTsTypeName,
  getTypeRef,
  isBuiltinType,
  isStringEnumSupported,
  toUppercaseFirst,
} from './utils'

/**
 * Generate Scalar, Enum, Input Object, and Union
 */
export class SimpleTypesGenerator {
  constructor(protected options: GenerateTypescriptOptions) {}

  public async generate(
    introspectResult: IntrospectionQuery,
  ): Promise<string[]> {
    const gqlTypes = introspectResult.__schema.types.filter(
      type => !isBuiltinType(type),
    )

    const typeDefs: string[] = [
      // 'export type Value<T> = T | Promise<T>',
      ''
    ]

    return gqlTypes.reduce<string[]>((prevTypescriptDefs, gqlType) => {
      const jsDoc = descriptionToJSDoc({ description: gqlType.description })
      let typeScriptDefs: string[] = []

      switch (gqlType.kind) {
        case 'OBJECT':
        case 'INTERFACE': {
          typeScriptDefs = typeScriptDefs.concat(
            this.generateObjectOrInterface(gqlType, gqlTypes),
          )
          break
        }
        case 'SCALAR': {
          typeScriptDefs = typeScriptDefs.concat(jsDoc)
          typeScriptDefs = typeScriptDefs.concat(
            this.generateCustomScalarType(gqlType),
          )
          break
        }

        case 'ENUM': {
          typeScriptDefs = typeScriptDefs.concat(jsDoc)
          typeScriptDefs = typeScriptDefs.concat(this.generateEnumType(gqlType))
          break
        }

        case 'INPUT_OBJECT': {
          typeScriptDefs = typeScriptDefs.concat(jsDoc)
          typeScriptDefs = typeScriptDefs.concat(
            this.generateInputObjectType(gqlType),
          )
          break
        }

        case 'UNION': {
          typeScriptDefs = typeScriptDefs.concat(jsDoc)
          typeScriptDefs = typeScriptDefs.concat(
            this.generateUnionType(gqlType),
          )
          break
        }

        default: {
          throw new Error(`Unknown type kind ${(gqlType as any).kind}`)
        }
      }

      typeScriptDefs.push('')

      return prevTypescriptDefs.concat(typeScriptDefs)
    }, typeDefs)
  }

  private generateCustomScalarType(
    scalarType: IntrospectionScalarType,
  ): string[] {
    const customScalarType = this.options.customScalarType || {}
    const tsName = `${this.options.typePrefix}${scalarType.name}`
    const customTsName = customScalarType[scalarType.name] || 'any'
    if (customTsName !== tsName) {
      return [`export type ${tsName} = ${customTsName}`]
    }
    return []
  }

  private generateEnumType(enumType: IntrospectionEnumType): string[] {
    // if using old typescript, which doesn't support string enum: convert enum to string union
    if (!isStringEnumSupported()) {
      return createTsUnionType(
        enumType.name,
        enumType.enumValues.map(v => `'${v.name}'`),
        this.options.typePrefix,
      )
    }

    // if generate as global, don't generate string enum as it requires import
    if (this.options.global) {
      return [
        ...createTsUnionType(
          enumType.name,
          enumType.enumValues.map(v => `'${v.name}'`),
          this.options.typePrefix,
        ),
        `// NOTE: enum ${
          enumType.name
        } is generate as string union instead of string enum because the types is generated under global scope`,
      ]
    }

    const enumBody = enumType.enumValues.reduce<string[]>(
      (prevTypescriptDefs, enumValue, index) => {
        let typescriptDefs: string[] = []
        const enumValueJsDoc = descriptionToJSDoc(enumValue)

        const isLastEnum = index === enumType.enumValues.length - 1

        if (!isLastEnum) {
          typescriptDefs = [
            ...enumValueJsDoc,
            `${enumValue.name} = '${enumValue.name}',`,
          ]
        } else {
          typescriptDefs = [
            ...enumValueJsDoc,
            `${enumValue.name} = '${enumValue.name}'`,
          ]
        }

        return prevTypescriptDefs.concat(typescriptDefs)
      },
      [],
    )

    return [
      `export enum ${this.options.typePrefix}${enumType.name} {`,
      ...enumBody,
      '}',
    ]
  }

  private generateInputObjectType(
    objectType: IntrospectionInputObjectType,
  ): string[] {
    const fields = objectType.inputFields

    const objectFields = fields.reduce<string[]>(
      (prevTypescriptDefs, field, index) => {
        const fieldJsDoc = descriptionToJSDoc(field)

        const typeRef = getTypeRef(field)

        const fieldNameAndType = createFieldRef(
          field.name,
          typeRef,
          this.options.typePrefix,
        )
        let typescriptDefs = [...fieldJsDoc, fieldNameAndType]

        if (fieldJsDoc.length > 0) {
          typescriptDefs = ['', ...typescriptDefs]
        }

        return prevTypescriptDefs.concat(typescriptDefs)
      },
      [],
    )

    return [
      `export interface ${this.options.typePrefix}${objectType.name} {`,
      ...objectFields,
      '}',
    ]
  }

  private generateUnionType(unionType: IntrospectionUnionType): string[] {
    const { typePrefix } = this.options
    const possibleTypesNames = [
      '',
      `/** Use this to resolve union type ${unionType.name} */`,
      ...createTsUnionType(
        `Possible${unionType.name}TypeNames`,
        unionType.possibleTypes.map(pt => `'${pt.name}'`),
        this.options.typePrefix,
      ),
    ]
    const possibleTypeNamesMap = [
      '',
      `export interface ${this.options.typePrefix}${unionType.name}NameMap {`,
      `${unionType.name}: ${this.options.typePrefix}${unionType.name}`,
      ...unionType.possibleTypes.map(pt => {
        return `${pt.name}: ${this.options.typePrefix}${pt.name}`
      }),
      '}',
    ]

    const unionTypeTSDefs = createTsUnionType(
      unionType.name,
      unionType.possibleTypes.map(type => {
        if (isBuiltinType(type)) {
          return type.name
        } else {
          return typePrefix + type.name
        }
      }),
      this.options.typePrefix,
    )

    return [...unionTypeTSDefs, ...possibleTypesNames, ...possibleTypeNamesMap]
  }

  /**
   * e.g. type User { id: string }
   */
  private generateObjectOrInterface(
    gqlType: IntrospectionObjectType | IntrospectionInterfaceType,
    allGQLTypes: IntrospectionType[],
  ): string[] {
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

    const modelName = `${this.options.typePrefix}${gqlType.name}`
    const body: string[] = []

    gqlType.fields.forEach(field => {
      if (
        extendFields.indexOf(field.name) !== -1 &&
        this.options.minimizeInterfaceImplementation
      ) {
        return
      }
      const res = this.generateObjectField(gqlType, field)
      body.push(...res)
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
            .map(t => `${this.options.typePrefix}${t}`)
            .join(', ')} `

    return [
      `// MARK: --- ${modelName}`,
      '',
      ...objectJsDoc,
      `export interface ${modelName} ${extendStr}{`,
      ...body,
      '}',
      ...possibleTypeNames,
      ...possibleTypeNamesMap,
    ]
  }

  private generateObjectField(
    objectType: IntrospectionObjectType | IntrospectionInterfaceType,
    field: IntrospectionField,
  ): string[] {

    const uppercaseFisrtFieldName = toUppercaseFirst(field.name)

    // If there is argument, require an explicit resolver for it
    if (field.args.length > 0) {
      return
    }
    const typeName = getModifiedTsTypeName(
      getTypeRef(field),
      this.options.typePrefix,
    )

    return [`${field.name}?: ${typeName}`]
  }
}
