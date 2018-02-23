import { GenerateTypescriptOptions } from './types';
import {
    isBuiltinType,
    getFieldRef,
    gqlScalarToTS,
    createFieldRef,
    toUppercaseFirst
} from './utils';
import {
    IntrospectionScalarType,
    IntrospectionObjectType,
    IntrospectionInterfaceType,
    IntrospectionUnionType
} from 'graphql';
import { IntrospectionQuery } from 'graphql/utilities/introspectionQuery';

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
            '/**',
            ' * This interface define the shape of your resolver',
            ' * Note that this type is designed to be compatible with graphql-tools resolvers',
            ' * However, you can still use other generated interfaces to make your resolver type-safed',
            ' */',
`
// TODO: Make this handle Nullability
// export type Result<T> = T | Promise<T>
// export type NullableResult<T> = T | null | Promise<T | null>

export type Result<T> = T | null | Promise<T | null>
export type GQLField<P, Args, Ctx, T> =
 | Result<T>
 | ((parent: P, args: Args, context: Ctx, info: GraphQLResolveInfo) => Result<T>)
`,
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
        const interfaceName = `${this.options.typePrefix}${type.name}Interface`;

        this.resolverInterfaces.push(...[
            `export interface ${interfaceName}<P = any> {`,
            `(parent: P, context: ${this.contextType}, info: GraphQLResolveInfo): ${possbileTypes.join(' | ')};`,
            '}'
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

                fieldResolversTypeDefs.push([
                    `export interface ${argsType} {`,
                    argsBody.join(', '),
                    '}'
                ].join(' '));
                // argsType = [
                //   `{ `,
                //   ...argsBody,
                //   ' }'
                // ].join('');
            }

            // generate field type
            const fieldResolverName = `${objectType.name}_${uppercaseFisrtFieldName}_Field`;

            console.log('field', field)
            const typeName = `${field.type['name']}`

            fieldResolversTypeDefs.push(...[
                `export type ${fieldResolverName}<P> = GQLField<P, ${argsType}, ${this.contextType}, ${typeName}>`
            ]);

            typeResolverBody.push(...[
                `${field.name}?: ${fieldResolverName}<P>`
            ]);
        });

        this.resolverInterfaces.push(...[
          '',
          `// --- ${typeResolverName}`,
          '',
            `export interface ${typeResolverName}<P = any> {`,
            ...typeResolverBody,
            '}',
            '',
            ...fieldResolversTypeDefs
        ]);

        // add the type resolver to resolver object
        this.resolverObject.push(...[
            `${objectType.name}?: ${typeResolverName};`
        ]);
    }
}