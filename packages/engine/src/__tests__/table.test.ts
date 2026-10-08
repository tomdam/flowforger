// Create CSV/HTML table against the cloud's output for the same rows (conformance/flows/tables.ff.ts).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTable, htmlEncode, TableInputError } from '../table.js';

const rows = [
  { name: `A <b>&"x" 'y'`, n: 1.5, flag: true, none: null, obj: { k: 'v', n: 1 }, arr: [1, 'a', null], comma: 'a,b', nl: 'l1\nl2', uml: 'ä€😀' },
  { name: 'B', n: 0, flag: false, extra: 'only in row 2' },
];

describe('createTable', () => {
  it('automatic columns: every key of every row, cells as string() writes them', () => {
    assert.equal(
      createTable('CSV', rows),
      'name,n,flag,none,obj,arr,comma,nl,uml,extra\r\n' +
        '"A <b>&""x"" \'y\'",1.5,True,,"{""k"":""v"",""n"":1}","[1,""a"",null]","a,b","l1\nl2",ä€😀,\r\n' +
        'B,0,False,,,,,,,only in row 2\r\n',
    );
    assert.equal(
      createTable('HTML', rows),
      '<table><thead><tr><th>name</th><th>n</th><th>flag</th><th>none</th><th>obj</th><th>arr</th><th>comma</th><th>nl</th><th>uml</th><th>extra</th></tr></thead><tbody>' +
        '<tr><td>A &lt;b&gt;&amp;&quot;x&quot; &#39;y&#39;</td><td>1.5</td><td>True</td><td></td><td>{&quot;k&quot;:&quot;v&quot;,&quot;n&quot;:1}</td><td>[1,&quot;a&quot;,null]</td><td>a,b</td><td>l1\nl2</td><td>&#228;€&#128512;</td><td></td></tr>' +
        '<tr><td>B</td><td>0</td><td>False</td><td></td><td></td><td></td><td></td><td></td><td></td><td>only in row 2</td></tr>' +
        '</tbody></table>',
    );
  });

  it('custom columns: headers encoded too, the header row even without rows', () => {
    const columns = [
      { header: 'Name, "quoted" <h>', cell: (item: any) => item.name },
      { header: '', cell: (item: any) => item.missing },
    ];
    assert.equal(createTable('CSV', rows, columns), '"Name, ""quoted"" <h>",\r\n"A <b>&""x"" \'y\'",\r\nB,\r\n');
    assert.equal(createTable('CSV', [], [{ header: 'A', cell: () => 1 }]), 'A\r\n');
    assert.equal(createTable('HTML', [], [{ header: 'A', cell: () => 1 }]), '<table><thead><tr><th>A</th></tr></thead><tbody></tbody></table>');
  });

  it('automatic columns over no rows', () => {
    assert.equal(createTable('CSV', []), '');
    assert.equal(createTable('HTML', []), '<table><tbody></tbody></table>');
  });

  it('rejects what the cloud rejects', () => {
    assert.throws(() => createTable('HTML', null), (err: unknown) =>
      err instanceof TableInputError &&
      err.message === "The 'from' property value in the 'table' action inputs is of type 'Null'. The value must be of type 'Array'." &&
      err.messageTemplate === "The '{0}' property value in the 'table' action inputs is of type '{1}'. The value must be of type '{2}'.");
    assert.throws(() => createTable('CSV', { a: 1 }), /is of type 'Object'\. The value must be of type 'Array'\./);
    assert.throws(() => createTable('CSV', ['a', 'b']), /The property 'columns' must be specified unless the 'from' property value is an array of objects\./);
    assert.throws(() => createTable('HTML', [{ a: 1 }, 'x']), TableInputError);
  });
});

describe('htmlEncode', () => {
  it('encodes like WebUtility.HtmlEncode', () => {
    assert.equal(htmlEncode(`<>&"' ä €😀\n`), '&lt;&gt;&amp;&quot;&#39; &#228;&#160;€&#128512;\n');
  });
});
