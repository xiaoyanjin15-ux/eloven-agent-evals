import JSZip from "jszip";

/**
 * Some WPS-produced workbooks prefix every OOXML element (for example
 * x:workbook). ExcelJS does not recognise that valid-but-unusual form, so
 * normalise element prefixes before loading while preserving workbook data.
 */
export async function normaliseNamespacedWorkbook(bytes: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes);
  const workbookEntry = zip.file("xl/workbook.xml");
  if (!workbookEntry) return bytes;
  const workbookXml = await workbookEntry.async("string");
  if (!/<\/?[A-Za-z_][\w.-]*:workbook\b/.test(workbookXml)) return bytes;
  const xmlEntries = Object.values(zip.files).filter((entry) => !entry.dir && /(?:\.xml|\.rels)$/i.test(entry.name));
  await Promise.all(xmlEntries.map(async (entry) => {
    const xml = await entry.async("string");
    let normalised = xml.replace(/<(\/?)\s*[A-Za-z_][\w.-]*:(?=[A-Za-z_])/g, "<$1");
    // ExcelJS cannot resolve the absolute table relationships emitted by some
    // namespaced workbooks. Tables are presentation metadata for case import;
    // keep every cell and the untouched original file, but omit table bindings
    // from this in-memory parsing copy.
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name)) {
      normalised = normalised.replace(/<tableParts\b[^>]*>[\s\S]*?<\/tableParts>/g, "")
        .replace(/<tableParts\b[^>]*\/>/g, "");
    }
    zip.file(entry.name, normalised);
  }));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
