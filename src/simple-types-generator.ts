import {
  IntrospectionEnumType,
  IntrospectionInputObjectType,
  IntrospectionQuery,
  IntrospectionScalarType,
  IntrospectionUnionType,
} from 'graphql'

import { GenerateTypescriptOptions } from './options'
import {
  createFieldRef,
  createTsUnionType,
  descriptionToJSDoc,
  getTypeRef,
  isBuiltinType,
  isStringEnumSupported,
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

    return gqlTypes.reduce<string[]>((prevTypescriptDefs, gqlType) => {
      const jsDoc = descriptionToJSDoc({ description: gqlType.description })
      let typeScriptDefs: string[] = [].concat(jsDoc)

      switch (gqlType.kind) {
        case 'OBJECT':
        case 'INTERFACE': {
          // These will be handled by resolver-types-generator
          return prevTypescriptDefs
        }
        case 'SCALAR': {
          typeScriptDefs = typeScriptDefs.concat(
            this.generateCustomScalarType(gqlType),
          )
          break
        }

        case 'ENUM': {
          typeScriptDefs = typeScriptDefs.concat(this.generateEnumType(gqlType))
          break
        }

        case 'INPUT_OBJECT': {
          typeScriptDefs = typeScriptDefs.concat(
            this.generateInputObjectType(gqlType),
          )
          break
        }

        case 'UNION': {
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
    }, [])
  }

  private generateCustomScalarType(
    scalarType: IntrospectionScalarType,
  ): string[] {
    const customScalarType = this.options.customScalarType || {}
    if (customScalarType[scalarType.name]) {
      return [
        `export type ${this.options.typePrefix}${scalarType.name} = ${
          customScalarType[scalarType.name]
        }`,
      ]
    }

    return [`export type ${this.options.typePrefix}${scalarType.name} = any`]
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
}
