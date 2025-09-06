const cols = Symbol.for('drizzle:Columns');
const name = Symbol.for('drizzle:Name');
const schemaSym = Symbol.for('drizzle:Schema');
const userId = { name: 'id', primary: true, notNull: true };
const email = { name: 'email', isUnique: true };
export const users = { [cols]: { id: userId, email }, [name]: 'users', [schemaSym]: 'main' };
