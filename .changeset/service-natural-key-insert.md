---
'@drzl/generator-service': patch
---

A stub service can insert a row with a natural primary key

`Insert<T>` excluded every primary key column. That is right for a key the server supplies and
wrong for one it does not: a `books` table keyed by `isbn` had no way to carry its own isbn, so the
one value that addresses the row had nowhere to come from and no insert could be expressed at all.

Being a primary key is not what makes a column omissible; being one the database can fill in is. The
condition now reads the column rather than the key, so a `serial` or identity key emits exactly the
bytes it did before and only a natural key moves.

The update type is unchanged. A patch that re-keys a row is a different operation, and the key
arrives as the `id` argument beside the patch.
