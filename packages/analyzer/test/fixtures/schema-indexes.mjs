const COLUMNS = Symbol.for('drizzle:Columns');
const NAME = Symbol.for('drizzle:Name');
const EXTRA = Symbol.for('drizzle:ExtraConfigBuilder');
const users = {
  [COLUMNS]: {
    email: { name: 'email' },
    username: { name: 'username' },
    createdAt: { name: 'createdAt' },
  },
  [NAME]: 'users',
};
users[EXTRA] = (t) => ({
  uq_email_username: {
    config: {
      name: 'uq_email_username',
      unique: true,
      columns: [t[COLUMNS].email, t[COLUMNS].username],
    },
  },
  idx_created_at: {
    config: { name: 'idx_created_at', unique: false, columns: [t[COLUMNS].createdAt] },
  },
});
export { users };
