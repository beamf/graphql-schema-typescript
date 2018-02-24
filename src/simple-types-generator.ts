import {
  IntrospectionEnumType,
  IntrospectionInputObjectType,
  IntrospectionQuery,
  IntrospectionScalarType,
  IntrospectionUnionType,
} from 'graphql'
import { versionMajorMinor as TSVersion } from 'typescript'

import { GenerateTypescriptOptions } from './options'
import {
  createFieldRef,
  descriptionToJSDoc,
  getFieldRef,
  gqlScalarToTS,
  isBuiltinType,
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
        case 'OBJECT':
        case 'INTERFACE': {
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
        };`,
      ]
    }

    return [`export type ${this.options.typePrefix}${scalarType.name} = any;`]
  }

  private isStringEnumSupported(): boolean {
    const [major, minor] = TSVersion.split('.').map(v => +v)
    return (major === 2 && minor >= 5) || major > 2
  }

  private generateEnumType(enumType: IntrospectionEnumType): string[] {
    // if using old typescript, which doesn't support string enum: convert enum to string union
    if (!this.isStringEnumSupported()) {
      return this.createUnionType(
        enumType.name,
        enumType.enumValues.map(v => `'${v.name}'`),
      )
    }

    // if generate as global, don't generate string enum as it requires import
    if (this.options.global) {
      return [
        ...this.createUnionType(
          enumType.name,
          enumType.enumValues.map(v => `'${v.name}'`),
        ),
        `// NOTE: enum ${
          enumType.name
        } is generate as string union instead of string enum because the types is generated under global scope`,
      ]
    }

    let enumBody = enumType.enumValues.reduce<string[]>(
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

        if (enumValueJsDoc.length > 0) {
          typescriptDefs = ['', ...typescriptDefs]
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
    let fields = objectType.inputFields

    const objectFields = fields.reduce<string[]>(
      (prevTypescriptDefs, field, index) => {
        let fieldJsDoc = descriptionToJSDoc(field)

        let { refKind, refName, fieldModifier } = getFieldRef(field)

        if (refKind === 'SCALAR') {
          refName = gqlScalarToTS(refName, this.options.typePrefix)
        } else {
          refName = `${this.options.typePrefix}${refName}`
        }

        const fieldNameAndType = createFieldRef(
          field.name,
          refName,
          fieldModifier,
        )
        let typescriptDefs = [...fieldJsDoc, fieldNameAndType]

        if (fieldJsDoc.length > 0) {
          typescriptDefs = ['', ...typescriptDefs]
        }

        return prevTypescriptDefs.concat(typescriptDefs)
      },
      [],
    )

    const possibleTypeNames: string[] = []
    const possibleTypeNamesMap: string[] = []
    return [
      `export interface ${this.options.typePrefix}${objectType.name} {`,
      ...objectFields,
      '}',
      ...possibleTypeNames,
      ...possibleTypeNamesMap,
    ]
  }

  private generateUnionType(unionType: IntrospectionUnionType): string[] {
    const { typePrefix } = this.options
    const possibleTypesNames = [
      '',
      `/** Use this to resolve union type ${unionType.name} */`,
      ...this.createUnionType(
        `Possible${unionType.name}TypeNames`,
        unionType.possibleTypes.map(pt => `'${pt.name}'`),
      ),
    ]
    const possibleTypeNamesMap = [
      '',
      `export interface ${this.options.typePrefix}${unionType.name}NameMap {`,
      `${unionType.name}: ${this.options.typePrefix}${unionType.name};`,
      ...unionType.possibleTypes.map(pt => {
        return `${pt.name}: ${this.options.typePrefix}${pt.name};`
      }),
      '}',
    ]

    const unionTypeTSDefs = this.createUnionType(
      unionType.name,
      unionType.possibleTypes.map(type => {
        if (isBuiltinType(type)) {
          return type.name
        } else {
          return typePrefix + type.name
        }
      }),
    )

    return [...unionTypeTSDefs, ...possibleTypesNames, ...possibleTypeNamesMap]
  }

  /**
   * Create a union type e.g: type Color = 'Red' | 'Green' | 'Blue' | ...
   * Also, if the type is too long to fit in one line, split them info multiple lines
   * => type Color = 'Red'
   *      | 'Green'
   *      | 'Blue'
   *      | ...
   */
  private createUnionType(typeName: string, possibleTypes: string[]): string[] {
    let result = `export type ${
      this.options.typePrefix
    }${typeName} = ${possibleTypes.join(' | ')};`
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
}
