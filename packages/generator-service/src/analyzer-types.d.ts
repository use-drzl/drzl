declare module '@drzl/analyzer' {
  export interface Column {
    name: string;
    tsType: string;
    dbType: string;
    nullable: boolean;
    hasDefault: boolean;
    isGenerated: boolean;
    defaultExpression?: string;
    references?: { table: string; column: string; onDelete?: string; onUpdate?: string };
    enumValues?: string[];
  }
  export interface Table {
    name: string;
    tsName: string;
    columns: Column[];
    primaryKey?: { columns: string[] };
  }
  export interface Analysis {
    tables: Table[];
    dialect?: string;
    enums?: any[];
    relations?: any[];
    issues?: any[];
  }
}
