import { describe, expect, it } from 'vitest';

import {
  findPlaceholderNames,
  findScriptAssignments,
  substitute,
} from '../src/lib/placeholders';
import { reportPlaceholders, resolveVariables } from '../src/lib/variables';

describe('findPlaceholderNames', () => {
  it('lists each name once, in the order first seen', () => {
    expect(findPlaceholderNames('{{b}}/{{ a }}/{{b}}')).toEqual(['b', 'a']);
  });

  it('agrees with substitution about what a placeholder is', () => {
    const text = '{{ok}} {{ 1bad }} {{also_ok}}';
    expect(findPlaceholderNames(text)).toEqual(['ok', 'also_ok']);
    expect(substitute(text, { ok: 'x', '1bad': 'y', also_ok: 'z' })).toBe(
      'x {{ 1bad }} z',
    );
  });
});

describe('resolveVariables', () => {
  const layers = {
    collection: [
      { name: 'host', value: 'https://collection.example' },
      { name: 'token', value: 'collection-token' },
    ],
    environment: [
      { name: 'token', value: 'environment-token', secret: true },
      { name: 'stage', value: 'staging' },
    ],
    script: { token: 'captured-token' },
  };

  it('layers collection under environment under script', () => {
    const { values } = resolveVariables(layers);
    expect(values).toEqual({
      host: 'https://collection.example',
      token: 'captured-token',
      stage: 'staging',
    });
  });

  it('records which layer won and which were shadowed', () => {
    const { byName } = resolveVariables(layers);
    expect(byName.token?.scope).toBe('script');
    expect(byName.token?.shadowed).toEqual(['collection', 'environment']);
    expect(byName.host?.scope).toBe('collection');
    expect(byName.host?.shadowed).toEqual([]);
  });

  it('keeps the secret flag of the layer that won', () => {
    const { byName } = resolveVariables({
      environment: [{ name: 'token', value: 'secret-value', secret: true }],
    });
    expect(byName.token?.secret).toBe(true);
  });

  it('ignores nameless entries rather than creating an empty variable', () => {
    const { list } = resolveVariables({
      collection: [{ name: '   ', value: 'x' }],
    });
    expect(list).toEqual([]);
  });
});

describe('reportPlaceholders', () => {
  const resolution = resolveVariables({
    collection: [{ name: 'host', value: 'https://api.example' }],
    environment: [{ name: 'token', value: 'super-secret-token', secret: true }],
  });

  const report = reportPlaceholders(
    {
      url: ['{{host}}/v1/items?stage={{stage}}'],
      header: ['Bearer {{token}}'],
      body: ['{"id":"{{item_id}}"}'],
    },
    resolution,
  );

  it('lists unresolved names first, because those are the bug', () => {
    expect(report.map((entry) => entry.name)).toEqual([
      'item_id',
      'stage',
      'host',
      'token',
    ]);
    expect(report[0]?.resolved).toBe(false);
    expect(report[0]?.preview).toBe('not set');
  });

  it('says where each resolved name came from and where it is used', () => {
    const host = report.find((entry) => entry.name === 'host');
    expect(host?.scope).toBe('collection');
    expect(host?.used).toEqual(['url']);
    expect(host?.preview).toBe('https://api.example');
  });

  it('measures a secret instead of previewing it', () => {
    const token = report.find((entry) => entry.name === 'token');
    expect(token?.secret).toBe(true);
    expect(token?.preview).toMatch(/^•+ \(18 characters, encrypted\)$/);
    expect(token?.preview).not.toContain('super-secret-token');
  });

  it('collects every place a name is used', () => {
    const multi = reportPlaceholders(
      { url: ['{{x}}'], header: ['{{x}}'], body: ['{{x}}'] },
      resolveVariables({ collection: [{ name: 'x', value: '1' }] }),
    );
    expect(multi[0]?.used).toEqual(['url', 'header', 'body']);
  });
});

describe('findScriptAssignments', () => {
  it('finds both ways a script can set a variable', () => {
    const script = [
      'vars.stamp = String(Date.now());',
      "vars['signature'] = sign(vars.stamp);",
      'vars["nonce"]=1;',
      'const other = vars.stamp;',
      '// vars.commented = 1',
    ].join('\n');
    expect(findScriptAssignments(script)).toEqual([
      'stamp',
      'signature',
      'nonce',
      'commented',
    ]);
  });

  it('is not fooled by a comparison', () => {
    expect(findScriptAssignments('if (vars.a == 1) {}')).toEqual([]);
    expect(findScriptAssignments('if (vars.a === 1) {}')).toEqual([]);
  });

  it('reads the script rather than running it', () => {
    // A hostile script must not be executed to describe it; a regex cannot.
    expect(() =>
      findScriptAssignments('while (true) { vars.x = 1; } throw new Error("no");'),
    ).not.toThrow();
    expect(findScriptAssignments('while (true) { vars.x = 1; }')).toEqual(['x']);
  });
});

describe('reportPlaceholders with a script', () => {
  it('reports a script-assigned name as set rather than missing', () => {
    const report = reportPlaceholders(
      { url: ['https://api.example/?ts={{stamp}}&id={{unset}}'] },
      resolveVariables({}),
      { scriptAssigned: ['stamp'] },
    );

    const stamp = report.find((entry) => entry.name === 'stamp');
    expect(stamp).toMatchObject({
      resolved: true,
      scope: 'script',
      preview: 'set by the pre-request script',
    });
    expect(report.find((entry) => entry.name === 'unset')?.resolved).toBe(false);
  });

  it('prefers a stored value over the script note', () => {
    const report = reportPlaceholders(
      { url: ['{{token}}'] },
      resolveVariables({ environment: [{ name: 'token', value: 'stored' }] }),
      { scriptAssigned: ['token'] },
    );
    expect(report[0]).toMatchObject({ scope: 'environment', preview: 'stored' });
  });
});
