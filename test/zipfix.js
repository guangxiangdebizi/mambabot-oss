import { crc32, deflateRawSync } from 'node:zlib';

// Writes small ZIP archives for tests (Office documents built from XML strings).
export function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const deflate = data.length > 64;
    const body = deflate ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// A 1×1 PNG.
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rootRels = (target) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="${target}"/></Relationships>`;

export function sampleDocx() {
  return makeZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    '_rels/.rels': rootRels('word/document.xml'),
    'word/_rels/document.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId5" Type="${REL}/hyperlink" Target="https://example.com/a?b=1&amp;c=2" TargetMode="External"/>
      <Relationship Id="rId6" Type="${REL}/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>
      <Relationship Id="rId7" Type="${REL}/image" Target="media/image1.png"/>
      <Relationship Id="rId8" Type="${REL}/image" Target="media/image2.emf"/>
      <Relationship Id="rId9" Type="${REL}/styles" Target="styles.xml"/>
      <Relationship Id="rId10" Type="${REL}/numbering" Target="numbering.xml"/></Relationships>`,
    'word/styles.xml': `<?xml version="1.0"?><w:styles ${W}>
      <w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style>
      <w:style w:type="paragraph" w:styleId="MyHeading"><w:name w:val="My Heading"/><w:basedOn w:val="1"/></w:style></w:styles>`,
    'word/numbering.xml': `<?xml version="1.0"?><w:numbering ${W}>
      <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
        <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1.%2)"/></w:lvl></w:abstractNum>
      <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="&#xF0B7;"/></w:lvl></w:abstractNum>
      <w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlText w:val="%1、"/></w:lvl></w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
      <w:num w:numId="3"><w:abstractNumId w:val="2"/></w:num></w:numbering>`,
    'word/media/image1.png': PNG,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
  <w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>标题 &lt;一&gt;</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="MyHeading"/><w:jc w:val="center"/></w:pPr><w:r><w:t>继承的标题</w:t></w:r></w:p>
  <w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">粗体 </w:t></w:r><w:r><w:rPr><w:b w:val="0"/><w:i/></w:rPr><w:t>斜体</w:t></w:r><w:r><w:tab/><w:t>制表</w:t><w:br/><w:t>换行</w:t></w:r>
    <w:hyperlink r:id="rId5"><w:r><w:t>链接</w:t></w:r></w:hyperlink><w:hyperlink r:id="rId6"><w:r><w:t>坏链接</w:t></w:r></w:hyperlink>
    <w:del><w:r><w:delText>删掉的</w:delText></w:r></w:del><w:r><w:instrText>PAGE</w:instrText></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>第一项</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>子项</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>第二项</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>圆点</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>中文编号</w:t></w:r></w:p>
  <w:p/><w:p/><w:p/>
  <w:tbl>
    <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>合并两列</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>纵向</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr>
  </w:tbl>
  <w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><wp:docPr id="1" name="图片 1" descr="示意图"/><a:graphic><a:graphicData><a:blip r:embed="rId7"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>
    <w:r><w:drawing><wp:inline><a:graphic><a:graphicData><a:blip r:embed="rId8"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
  <w:sectPr/>
</w:body></w:document>`,
  });
}

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
export function sampleXlsx() {
  return makeZip({
    '_rels/.rels': rootRels('xl/workbook.xml'),
    'xl/workbook.xml': `<?xml version="1.0"?><workbook ${S}><workbookPr/><sheets><sheet name="销售" sheetId="1" r:id="rId1"/><sheet name="隐藏" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Type="${REL}/worksheet" Target="/xl/worksheets/sheet2.xml"/>
      <Relationship Id="rId3" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>
      <Relationship Id="rId4" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    'xl/sharedStrings.xml': `<?xml version="1.0"?><sst ${S}><si><t>日期</t></si><si><t>金额</t></si><si><r><t>富</t></r><r><t>文本</t></r><rPh><t>ふりがな</t></rPh></si></sst>`,
    'xl/styles.xml': `<?xml version="1.0"?><styleSheet ${S}><numFmts><numFmt numFmtId="164" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/><numFmt numFmtId="165" formatCode="#,##0.00"/></numFmts>
      <cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="10"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="22"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet ${S}><dimension ref="A1:D4"/><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
      <row r="2"><c r="A2" s="1"><v>45658</v></c><c r="B2" s="4"><v>1234567.891</v></c><c r="C2" s="2"><v>0.1234</v></c><c r="D2" t="b"><v>1</v></c></row>
      <row r="3"><c r="A3" s="3"><v>45658</v></c><c r="B3"><v>0.30000000000000004</v></c><c r="C3" t="inlineStr"><is><t>内联</t></is></c><c r="D3" t="str"><f>A1</f><v>公式结果</v></c></row>
      <row r="4"><c r="A4" s="5"><v>45658.5</v></c><c r="B4" t="e"><v>#DIV/0!</v></c></row>
    </sheetData><mergeCells count="1"><mergeCell ref="C1:D1"/></mergeCells></worksheet>`,
    'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><worksheet ${S}><sheetData><row r="1"><c r="B1"><v>42</v></c></row></sheetData></worksheet>`,
  });
}

const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
export function samplePptx() {
  return makeZip({
    '_rels/.rels': rootRels('ppt/presentation.xml'),
    'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="${REL}/slide" Target="slides/slide2.xml"/></Relationships>`,
    'ppt/slides/_rels/slide1.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="${REL}/image" Target="../media/image1.png"/><Relationship Id="rId2" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
    'ppt/media/image1.png': PNG,
    'ppt/slides/slide1.xml': `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>季度总结</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:rPr b="1"/><a:t>收入增长</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:t>环比 12%</a:t></a:r></a:p></p:txBody></p:sp>
      <p:pic><p:nvPicPr><p:cNvPr id="4" name="Pic" descr="图表"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/></p:blipFill><p:spPr><a:xfrm><a:ext cx="1905000" cy="952500"/></a:xfrm></p:spPr></p:pic>
      <p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>表头</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>
      <p:sp><p:nvSpPr><p:cNvPr id="5" name="Num"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody></p:sp>
    </p:spTree></p:cSld></p:sld>`,
    'ppt/notesSlides/notesSlide1.xml': `<?xml version="1.0"?><p:notes ${P}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="n"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>记得讲成本</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
    'ppt/slides/slide2.xml': `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree><p:grpSp><p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>分组里的文字</a:t></a:r></a:p></p:txBody></p:sp></p:grpSp></p:spTree></p:cSld></p:sld>`,
  });
}
