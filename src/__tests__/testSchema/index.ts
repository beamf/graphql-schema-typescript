import * as fs from 'fs';
import { graphql, GraphQLSchema, introspectionQuery } from 'graphql';
import { makeExecutableSchema } from 'graphql-tools';
import * as path from 'path';

const gqlFiles = fs.readdirSync(__dirname).filter(f => f.endsWith('.gql') || f.endsWith('.graphql'));

const typeDefs = gqlFiles.map(filePath => fs.readFileSync(path.join(__dirname, filePath), 'utf-8'));

export const testSchema: GraphQLSchema = makeExecutableSchema({
    typeDefs
});