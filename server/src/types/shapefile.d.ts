// Minimal types for the "shapefile" package (it ships none). Only byte buffers are ever passed in:
// a string argument would make the library read a file path.
declare module 'shapefile' {
  interface Source<T> { read(): Promise<{ done: boolean; value: T }>; cancel(): Promise<void> }
  export function open(shp: Uint8Array, dbf?: Uint8Array, options?: { encoding?: string }): Promise<Source<{ type: 'Feature'; geometry: Record<string, unknown> | null; properties: Record<string, unknown> }>>;
  export function openDbf(dbf: Uint8Array, options?: { encoding?: string }): Promise<Source<Record<string, unknown>>>;
}
