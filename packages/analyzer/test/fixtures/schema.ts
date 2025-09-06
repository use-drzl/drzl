const cols = Symbol.for('drizzle:Columns');
const name = Symbol.for('drizzle:Name');
const schemaSym = Symbol.for('drizzle:Schema');
const PrimaryKey = Symbol.for('drizzle:PrimaryKey');

const userId = { name: 'id', primary: true, notNull: true, constructor: { name: 'SQLiteInteger' } };
const email = { name: 'email', isUnique: true, constructor: { name: 'SQLiteText' } };
const users: any = { [cols]: { id: userId, email }, [name]: 'users', [schemaSym]: 'main' };

export { users };
