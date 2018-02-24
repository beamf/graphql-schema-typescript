import {
  IntrospectionInterfaceType,
  IntrospectionObjectType,
  IntrospectionScalarType,
  IntrospectionUnionType,
} from 'graphql';
import {
  IntrospectionField,
  IntrospectionListTypeRef,
  IntrospectionNamedTypeRef,
  IntrospectionNonNullTypeRef,
  IntrospectionQuery,
  IntrospectionTypeRef,
} from 'graphql/utilities/introspectionQuery';

import { GenerateTypescriptOptions } from './types';
import { createFieldRef, descriptionToJSDoc, getFieldRef, gqlScalarToTS, isBuiltinType, toUppercaseFirst } from './utils';

export interface GenerateResolversResult {
    importHeader: string[];
    body: string[];
}

export class TSResolverGenerator {
    protected importHeader: string[] = [];
    protected resolverInterfaces: string[] = [];
    protected resolverObject: string[] = [];
    protected contextType: string;

    constructor(protected options: GenerateTypescriptOptions) {
        if (options.resolver) {
            this.contextType = options.resolver.contextType;
            if (options.resolver.importContext) {
                this.importHeader.push(options.resolver.importContext);
            }
        } else {
            this.contextType = 'any';
        }
    }

    public async generate(introspectionResult: IntrospectionQuery): Promise<GenerateResolversResult> {

        const gqlTypes = introspectionResult.__schema.types.filter(type => !isBuiltinType(type));

        const hasCustomScalar = !!gqlTypes.find(type => type.kind === 'SCALAR');
        if (hasCustomScalar) {
            this.importHeader.push(`import { GraphQLResolveInfo, GraphQLScalarType } from 'graphql';`);
        } else {
            this.importHeader.push(`import { GraphQLResolveInfo } from 'graphql';`);
        }

        this.resolverObject = [
`
// TODO: Make this handle Nullability
// export type Result<T> = T | Promise<T>
// export type NullableResult<T> = T | null | Promise<T | null>

export type Result<T> = T | null | Promise<T | null>
export type GQLField<P, Args, Ctx, T> =
 | Result<T>
 | ((parent: P, args: Args, context: Ctx, info: GraphQLResolveInfo) => Result<T>)

export type GQLTypeResolver<P, Ctx, T> = 
  (parent: P, context: Ctx, info: GraphQLResolveInfo) => T
`,
            '/**',
            ' * This interface define the shape of your resolver',
            ' * Note that this type is designed to be compatible with graphql-tools resolvers',
            ' * However, you can still use other generated interfaces to make your resolver type-safed',
            ' */',
            `export interface AllResolvers {`
        ];

        gqlTypes.map(type => {
            switch (type.kind) {
                case 'SCALAR': {
                    this.generateCustomScalarResolver(type);
                    break;
                }

                case 'OBJECT': {
                    this.generateObjectResolver(type);
                    break;
                }

                case 'INTERFACE':
                case 'UNION': {
                    this.generateTypeResolver(type);
                    break;
                }

                case 'INPUT_OBJECT':
                default: {
                    break;
                }
            }
        });

        this.resolverObject.push('}');

        return {
            importHeader: this.importHeader,
            body: [...this.resolverObject, ...this.resolverInterfaces]
        };
    }

    private generateCustomScalarResolver(scalarType: IntrospectionScalarType) {
        this.resolverObject.push(`${scalarType.name}?: GraphQLScalarType;`);
    }

    private generateTypeResolver(type: IntrospectionUnionType | IntrospectionInterfaceType) {
        const possbileTypes = type.possibleTypes.map(pt => `'${pt.name}'`);
        const interfaceName = `${this.options.typePrefix}${type.name}_TypeResolver`;

        this.resolverInterfaces.push(...[
          '',
          `// MARK: --- ${interfaceName}`,
          '',
          `export type ${interfaceName}<P = any> = GQLTypeResolver<P, ${this.contextType}, ${possbileTypes.join(' | ')}>`,
            // `export interface ${interfaceName}<P = any> {`,
            // `(parent: P, context: ${this.contextType}, info: GraphQLResolveInfo): ${possbileTypes.join(' | ')};`,
            // '}'
        ]);

        this.resolverObject.push(...[
            `${type.name}?: {`,
            `__resolveType: ${interfaceName}`,
            '};',
            ''
        ]);
    }

    private generateObjectResolver(objectType: IntrospectionObjectType) {
        const typeResolverName = `${this.options.typePrefix}${objectType.name}`;
        const typeResolverBody: string[] = [];
        const fieldResolversTypeDefs: string[] = [];

        objectType.fields.forEach(field => {
            const res = this.generateObjectFieldResolver(objectType, field);
            typeResolverBody.push(...res.typeResolverBody);
            fieldResolversTypeDefs.push(...res.fieldResolversTypeDefs);

        });

        const objectJsDoc = descriptionToJSDoc(objectType);
        
        this.resolverInterfaces.push(...[
          '',
          `// MARK: --- ${typeResolverName}`,
          '',
          ...objectJsDoc,
            `export interface ${typeResolverName}<P = any> {`,
            ...typeResolverBody,
            '}',
            '',
            '',
            ...fieldResolversTypeDefs
        ]);

        // add the type resolver to resolver object
        this.resolverObject.push(...[
            `${objectType.name}?: ${typeResolverName};`
        ]);
    }

    private generateObjectFieldResolver(objectType: IntrospectionObjectType, field: IntrospectionField) {
      const typeResolverBody: string[] = [];
      const fieldResolversTypeDefs: string[] = [];

      // generate args type
      let argsType = '{}';

      let uppercaseFisrtFieldName = toUppercaseFirst(field.name);

      if (field.args.length > 0) {
          argsType = `${objectType.name}_${uppercaseFisrtFieldName}_Args`;
          const argsBody: string[] = [];
          field.args.forEach(arg => {
              const argRefField = getFieldRef(arg);

              let argRefName = argRefField.refName;

              if (argRefField.refKind === 'SCALAR') {
                  argRefName = gqlScalarToTS(argRefName, this.options.typePrefix);
              } else if (!isBuiltinType({ name: argRefName, kind: argRefField.refKind })) {
                  argRefName = this.options.typePrefix + argRefName;
              }

              const argFieldNameAndType = createFieldRef(arg.name, argRefName, argRefField.fieldModifier);
              argsBody.push(argFieldNameAndType);
          });

          const argsTypeDefs = [
            `export interface ${argsType} {`,
            argsBody.join(', '),
            '}'
        ].join(' ');

          fieldResolversTypeDefs.push('', argsTypeDefs);
          // argsType = [
          //   `{ `,
          //   ...argsBody,
          //   ' }'
          // ].join('');
      }


      // generate field type
      const fieldResolverName = `${objectType.name}_${uppercaseFisrtFieldName}_Field`;
      
      const typeName = this.getTsType(field.type);

      const fieldJsDocs = descriptionToJSDoc(field);

      fieldResolversTypeDefs.push(
        ...[
          ...fieldJsDocs,
          `export type ${fieldResolverName}<P> = GQLField<P, ${argsType}, ${this.contextType}, ${typeName}>`
      ]);

      typeResolverBody.push(...[
          `${field.name}?: ${fieldResolverName}<P>`
      ]);

      return { typeResolverBody, fieldResolversTypeDefs };
    }

    private getTsTypeName(type: IntrospectionNamedTypeRef): string {
      if (type.kind === 'SCALAR') {
        return gqlScalarToTS(type.name, this.options.typePrefix);
      }
      return `${this.options.typePrefix}${type.name}`;
    }

    private getTsType(type: IntrospectionTypeRef) {
      if (type.kind === 'LIST') {
        return `${this.getTsType((type as IntrospectionListTypeRef).ofType)}[]`;
      } else if (type.kind === 'NON_NULL') {
        return this.getTsType((type as IntrospectionNonNullTypeRef).ofType);
      } else {
        return `${this.getTsTypeName(type as IntrospectionNamedTypeRef)} | null`;
      }
    }
}