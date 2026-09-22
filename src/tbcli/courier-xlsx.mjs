import path from 'node:path';
import {unzipSync,strFromU8} from 'fflate';
import {SaxesParser} from 'saxes';

// Read by actual row/cell XML, independent of stale worksheet dimensions,
// worksheet ZIP ordering and empty formatted trailing rows.
function parse(xml, handlers) {
  const parser=new SaxesParser({xmlns:false});
  parser.on('doctype',()=>{throw new Error('XLSX_DOCTYPE_UNSUPPORTED');});
  for(const [event,handler] of Object.entries(handlers))parser.on(event,handler);
  parser.write(xml).close();
}
const local = name => name.split(':').at(-1);
export function readCourierSheet(bytes, sheetName) {
  const zip=unzipSync(bytes);
  const xml=name=>{if(!zip[name])throw new Error(`XLSX_PART_MISSING: ${name}`);return strFromU8(zip[name]);};
  const shared=[];let current='',inText=false,inString=false;
  if(zip['xl/sharedStrings.xml'])parse(xml('xl/sharedStrings.xml'),{
    opentag:n=>{if(local(n.name)==='si'){current='';inString=true;}if(local(n.name)==='t')inText=true;},
    text:t=>{if(inText&&inString)current+=t;},
    closetag:n=>{if(local(n.name)==='t')inText=false;if(local(n.name)==='si'){shared.push(current);inString=false;}},
  });
  const rels={};parse(xml('xl/_rels/workbook.xml.rels'),{opentag:n=>{if(local(n.name)==='Relationship')rels[n.attributes.Id]=n.attributes.Target;}});
  let target=null,date1904=false;
  parse(xml('xl/workbook.xml'),{opentag:n=>{
    if(local(n.name)==='workbookPr')date1904=['1','true'].includes(n.attributes.date1904);
    if(local(n.name)==='sheet'&&n.attributes.name===sheetName)target=rels[n.attributes['r:id']];
  }});
  if(!target)throw new Error('BILL_SHEET_MISSING');
  const part=target.startsWith('/')?target.slice(1):path.posix.normalize('xl/'+target);
  const rows=[];let row=null,cell=null,field=null;
  parse(xml(part),{
    opentag:n=>{
      const name=local(n.name);
      if(name==='row')row={number:Number(n.attributes.r),values:[]};
      if(name==='c')cell={ref:n.attributes.r,type:n.attributes.t||'n',raw:'',inline:''};
      if(cell&&['v','t'].includes(name))field=name;
    },
    text:t=>{if(cell&&field==='v')cell.raw+=t;if(cell&&field==='t')cell.inline+=t;},
    closetag:n=>{
      const name=local(n.name);
      if(['v','t'].includes(name))field=null;
      if(name==='c'&&cell&&row){
        let v=null;
        if(cell.type==='inlineStr')v=cell.inline;
        else if(cell.raw!=='') {
          if(cell.type==='s') {v=shared[Number(cell.raw)];if(v===undefined)throw new Error('XLSX_SHARED_STRING_MISSING');}
          else if(cell.type==='e')v={error:cell.raw};
          else if(cell.type==='n') {v=Number(cell.raw);if(!Number.isFinite(v))throw new Error('XLSX_INVALID_NUMBER');if(Number.isInteger(v)&&!Number.isSafeInteger(v))throw new Error('XLSX_UNSAFE_INTEGER');}
          else v=cell.raw;
        }
        if(v!==null){let col=0;for(const ch of cell.ref.replace(/\d/g,''))col=col*26+ch.charCodeAt(0)-64;row.values[col]=v;}
        cell=null;
      }
      if(name==='row'&&row){if(row.values.some(v=>v!==null&&v!==undefined&&v!==''))rows.push(row);row=null;}
    },
  });
  return {rows,date1904};
}
