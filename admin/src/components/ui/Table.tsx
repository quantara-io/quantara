import type { ReactNode } from "react";

interface Column<T> {
  key: string;
  header: ReactNode;
  align?: "left" | "right" | "center";
  width?: string;
  render: (row: T) => ReactNode;
  className?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  empty?: ReactNode;
  dense?: boolean;
  hoverable?: boolean;
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty = "No data",
  dense = false,
  hoverable = false,
  className = "",
}: DataTableProps<T>) {
  const cellPad = dense ? "py-1.5 px-3" : "py-2.5 px-3";
  return (
    <div className={`overflow-x-auto ${className}`}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-2xs uppercase tracking-widest text-muted">
            {columns.map((c) => (
              <th
                key={c.key}
                className={`${cellPad} font-medium text-${c.align ?? "left"} border-b border-line`}
                style={c.width ? { width: c.width } : undefined}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className={`${cellPad} text-center text-sm text-muted2`}
              >
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr
                key={rowKey(row, i)}
                className={`border-b border-line/60 ${hoverable ? "hover:bg-sunken/60 transition-colors" : ""}`}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`${cellPad} text-${c.align ?? "left"} text-ink2 ${c.className ?? ""}`}
                  >
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
