// eslint-disable-next-line import/no-extraneous-dependencies, import/no-unresolved
import { LogError } from "../utils";
import AbstractDriver from "./AbstractDriver";
import { IRDMSConnectionOptions } from "../types";
import { Entity } from "../models/Entity";
import { Column } from "../models/Column";
import { Index } from "../models/Index";
import { RelationInternal } from "../models/RelationInternal";
import {
  COLUMN_TYPES_WITH_LENGTH,
  COLUMN_TYPES_WITH_PRECISION,
} from "./_constants";

export default class OracleDriver extends AbstractDriver {
  constructor(connectionOptions: IRDMSConnectionOptions) {
    super(connectionOptions);
  }

  public formatQuery<T>(data: unknown[]) {
    return data as T[];
  }

  public async GetAllTables(): Promise<Entity[]> {
    const response = await this.runQuery<{
      TABLE_SCHEMA: string;
      TABLE_NAME: string;
      DB_NAME: string;
    }>(
      `SELECT NULL AS TABLE_SCHEMA, TABLE_NAME, NULL AS DB_NAME FROM all_tables WHERE owner = (select user from dual)`
    );
    const ret: Entity[] = [];
    response.forEach((val) => {
      ret.push({
        columns: [],
        indices: [],
        relations: [],
        relationIds: [],
        name: val.TABLE_NAME,
        schema: val.TABLE_SCHEMA,
      });
    });
    return ret;
  }

  public async GetCoulmnsFromEntity(entities: Entity[]): Promise<Entity[]> {
    const response = await this.runQuery<{
      TABLE_NAME: string;
      COLUMN_NAME: string;
      DATA_DEFAULT: string;
      NULLABLE: string;
      DATA_TYPE: string;
      DATA_LENGTH: number;
      DATA_PRECISION: number;
      DATA_SCALE: number;
      IDENTITY_COLUMN: string; // doesn't exist in old oracle versions (#195)
      IS_UNIQUE: number;
    }>(`SELECT utc.*, (select count(*) from USER_CONS_COLUMNS ucc
             JOIN USER_CONSTRAINTS uc ON  uc.CONSTRAINT_NAME = ucc.CONSTRAINT_NAME and uc.CONSTRAINT_TYPE='U'
            where ucc.column_name = utc.COLUMN_NAME AND ucc.table_name = utc.TABLE_NAME) IS_UNIQUE
           FROM USER_TAB_COLUMNS utc`);

    entities.forEach((ent) => {
      response
        .filter((filterVal) => filterVal.TABLE_NAME === ent.name)
        .forEach((resp) => {
          const tscName = resp.COLUMN_NAME;
          const options: Column["options"] = {
            name: resp.COLUMN_NAME,
          };
          if (resp.NULLABLE === "Y") options.nullable = true;
          if (resp.IS_UNIQUE > 0) options.unique = true;
          const generated = resp.IDENTITY_COLUMN === "YES" ? true : undefined;
          const defaultValue =
            !resp.DATA_DEFAULT || resp.DATA_DEFAULT.includes('"')
              ? undefined
              : OracleDriver.ReturnDefaultValueFunction(resp.DATA_DEFAULT);
          const DATA_TYPE = resp.DATA_TYPE.replace(/\([0-9]+\)/g, "");
          const columnType = DATA_TYPE.toLowerCase();
          let tscType = "";
          switch (DATA_TYPE.toLowerCase()) {
            case "char":
              tscType = "string";
              break;
            case "nchar":
              tscType = "string";
              break;
            case "nvarchar2":
              tscType = "string";
              break;
            case "varchar2":
              tscType = "string";
              break;
            case "long":
              tscType = "string";
              break;
            case "raw":
              tscType = "Buffer";
              break;
            case "long raw":
              tscType = "Buffer";
              break;
            case "number":
              tscType = "number";
              break;
            case "numeric":
              tscType = "number";
              break;
            case "float":
              tscType = "number";
              break;
            case "dec":
              tscType = "number";
              break;
            case "decimal":
              tscType = "number";
              break;
            case "integer":
              tscType = "number";
              break;
            case "int":
              tscType = "number";
              break;
            case "smallint":
              tscType = "number";
              break;
            case "real":
              tscType = "number";
              break;
            case "double precision":
              tscType = "number";
              break;
            case "date":
              tscType = "Date";
              break;
            case "timestamp":
              tscType = "Date";
              break;
            case "timestamp with time zone":
              tscType = "Date";
              break;
            case "timestamp with local time zone":
              tscType = "Date";
              break;
            case "interval year to month":
              tscType = "string";
              break;
            case "interval day to second":
              tscType = "string";
              break;
            case "bfile":
              tscType = "Buffer";
              break;
            case "blob":
              tscType = "Buffer";
              break;
            case "clob":
              tscType = "string";
              break;
            case "nclob":
              tscType = "string";
              break;
            case "rowid":
              tscType = "number";
              break;
            case "urowid":
              tscType = "number";
              break;
            default:
              tscType = "NonNullable<unknown>";
              LogError(`Unknown column type:${DATA_TYPE}`);
              break;
          }
          if (COLUMN_TYPES_WITH_PRECISION.some((v) => v === columnType)) {
            if (resp.DATA_PRECISION !== null) {
              options.precision = resp.DATA_PRECISION;
            }
            if (resp.DATA_SCALE !== null) {
              options.scale = resp.DATA_SCALE;
            }
          }
          if (COLUMN_TYPES_WITH_LENGTH.some((v) => v === columnType)) {
            options.length =
              resp.DATA_LENGTH > 0 ? resp.DATA_LENGTH : undefined;
          }

          ent.columns.push({
            generated,
            type: columnType,
            default: defaultValue,
            options,
            tscName,
            tscType,
          });
        });
    });
    return entities;
  }

  public async GetIndexesFromEntity(entities: Entity[]): Promise<Entity[]> {
    const response = await this.runQuery<{
      COLUMN_NAME: string;
      TABLE_NAME: string;
      INDEX_NAME: string;
      UNIQUENESS: string;
      ISPRIMARYKEY: number;
    }>(`SELECT ind.TABLE_NAME, ind.INDEX_NAME, col.COLUMN_NAME,ind.UNIQUENESS, CASE WHEN uc.CONSTRAINT_NAME IS NULL THEN 0 ELSE 1 END ISPRIMARYKEY
        FROM USER_INDEXES ind
        JOIN USER_IND_COLUMNS col ON ind.INDEX_NAME=col.INDEX_NAME
        LEFT JOIN USER_CONSTRAINTS uc ON  uc.INDEX_NAME = ind.INDEX_NAME
        ORDER BY col.INDEX_NAME ASC ,col.COLUMN_POSITION ASC`);

    entities.forEach((ent) => {
      const entityIndices = response.filter(
        (filterVal) => filterVal.TABLE_NAME === ent.name
      );
      const indexNames = new Set(entityIndices.map((v) => v.INDEX_NAME));
      indexNames.forEach((indexName) => {
        const records = entityIndices.filter((v) => v.INDEX_NAME === indexName);
        const indexInfo: Index = {
          columns: [],
          options: {},
          name: records[0].INDEX_NAME,
        };
        if (records[0].ISPRIMARYKEY === 1) indexInfo.primary = true;
        if (records[0].UNIQUENESS === "UNIQUE") indexInfo.options.unique = true;
        records.forEach((record) => {
          indexInfo.columns.push(record.COLUMN_NAME);
        });
        ent.indices.push(indexInfo);
      });
    });

    return entities;
  }

  public async GetRelations(entities: Entity[]): Promise<Entity[]> {
    const response = await this.runQuery<{
      OWNER_TABLE_NAME: string;
      OWNER_POSITION: string;
      OWNER_COLUMN_NAME: string;
      CHILD_TABLE_NAME: string;
      CHILD_COLUMN_NAME: string;
      DELETE_RULE: "RESTRICT" | "CASCADE" | "SET NULL" | "NO ACTION";
      CONSTRAINT_NAME: string;
    }>(`select owner.TABLE_NAME OWNER_TABLE_NAME,ownCol.POSITION OWNER_POSITION,ownCol.COLUMN_NAME OWNER_COLUMN_NAME,
        child.TABLE_NAME CHILD_TABLE_NAME ,childCol.COLUMN_NAME CHILD_COLUMN_NAME,
        owner.DELETE_RULE,
        owner.CONSTRAINT_NAME
        from user_constraints owner
        join user_constraints child on owner.r_constraint_name=child.CONSTRAINT_NAME and child.constraint_type in ('P','U')
        JOIN USER_CONS_COLUMNS ownCol ON owner.CONSTRAINT_NAME = ownCol.CONSTRAINT_NAME
        JOIN USER_CONS_COLUMNS childCol ON child.CONSTRAINT_NAME = childCol.CONSTRAINT_NAME AND ownCol.POSITION=childCol.POSITION
        ORDER BY OWNER_TABLE_NAME ASC, owner.CONSTRAINT_NAME ASC, OWNER_POSITION ASC`);

    const relationsTemp: RelationInternal[] = [] as RelationInternal[];
    const relationKeys = new Set(response.map((v) => v.CONSTRAINT_NAME));

    relationKeys.forEach((relationId) => {
      const rows = response.filter((v) => v.CONSTRAINT_NAME === relationId);
      const ownerTable = entities.find(
        (v) => v.name === rows[0].OWNER_TABLE_NAME
      );
      const relatedTable = entities.find(
        (v) => v.name === rows[0].CHILD_TABLE_NAME
      );

      if (!ownerTable || !relatedTable) {
        LogError(
          `Relation between tables ${rows[0].OWNER_TABLE_NAME} and ${rows[0].CHILD_TABLE_NAME} wasn't found in entity model.`
        );
        return;
      }
      const internal: RelationInternal = {
        ownerColumns: [],
        relatedColumns: [],
        ownerTable,
        relatedTable,
      };
      rows.forEach((row) => {
        internal.ownerColumns.push(row.OWNER_COLUMN_NAME);
        internal.relatedColumns.push(row.CHILD_COLUMN_NAME);
      });
      relationsTemp.push(internal);
    });

    const retVal = OracleDriver.GetRelationsFromRelationTempInfo(
      relationsTemp,
      entities
    );
    return retVal;
  }

  public async CheckIfDBExists(dbName: string): Promise<boolean> {
    const data = await this.runQuery<{ CNT: number }>(
      `select count(*) as CNT from dba_users where username='${dbName.toUpperCase()}'`
    );
    // return rows![0][0] > 0 || rows![0].CNT;
    return data[0].CNT > 0;
  }

  private static ReturnDefaultValueFunction(
    defVal: string | null
  ): string | undefined {
    let defaultVal = defVal?.trim();
    if (!defaultVal) {
      return undefined;
    }
    if (defaultVal.endsWith(" ")) {
      defaultVal = defaultVal.slice(0, -1);
    }

    return `() => "${defaultVal}"`;
  }
}
