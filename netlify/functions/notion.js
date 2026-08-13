const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const DB_IDS = {
  actions: '9ad685dca6294a8e8978f1314d0b1ada',
  governance: '0a17cd5ae06b44f49a0b71df06c3e71e',
  decisions: '216c56074fcb42d5b2b0ace5f606e1a0',
  learnings: '29360bfb014e80d68dc7fdd8ceb21875',
  milestones: '30560bfb014e80568a6dd1d280d91c88',
  pipeline: '9c9aa106c37b4aab9276199a37773dba',
  boulders: 'fec81333ee4a4414b80662029c6d22f8',
};

const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const response = (statusCode, body) => ({
  statusCode,
  headers,
  body: JSON.stringify(body),
});

const normaliseId = value => String(value || '').replace(/-/g, '').toLowerCase();

async function queryAll(databaseId, filter, sorts, pageSize = 100) {
  const results = [];
  let startCursor;

  do {
    const page = await notion.databases.query({
      database_id: databaseId,
      filter: filter || undefined,
      sorts: sorts || undefined,
      page_size: Math.min(Math.max(Number(pageSize) || 100, 1), 100),
      start_cursor: startCursor || undefined,
    });

    results.push(...page.results);
    startCursor = page.has_more ? page.next_cursor : undefined;
  } while (startCursor);

  return {
    object: 'list',
    results,
    has_more: false,
    next_cursor: null,
  };
}

async function completePage(pageId) {
  const page = await notion.pages.retrieve({ page_id: pageId });
  const databaseId = normaliseId(page.parent && page.parent.database_id);
  const actionsId = normaliseId(DB_IDS.actions);
  const governanceId = normaliseId(DB_IDS.governance);

  if (![actionsId, governanceId].includes(databaseId)) {
    const error = new Error('This page is not in an approved action database.');
    error.statusCode = 403;
    throw error;
  }

  const statusProperty = page.properties && page.properties.Status;
  if (!statusProperty || !['select', 'status'].includes(statusProperty.type)) {
    const error = new Error('The Notion page does not have an editable Status property.');
    error.statusCode = 400;
    throw error;
  }

  const properties = {
    Status: statusProperty.type === 'status'
      ? { status: { name: 'Done' } }
      : { select: { name: 'Done' } },
  };

  if (
    databaseId === governanceId &&
    page.properties['Completed Date'] &&
    page.properties['Completed Date'].type === 'date'
  ) {
    properties['Completed Date'] = {
      date: { start: new Date().toISOString().slice(0, 10) },
    };
  }

  const updated = await notion.pages.update({
    page_id: pageId,
    properties,
  });

  return { ok: true, id: updated.id, url: updated.url };
}

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (!process.env.NOTION_TOKEN) {
    return response(500, { error: 'NOTION_TOKEN is not configured.' });
  }

  if (event.httpMethod !== 'POST') {
    return response(405, { error: 'Method not allowed.' });
  }

  try {
    const body = JSON.parse(event.body || '{}');

    if (body.operation === 'complete') {
      if (!body.page_id) {
        return response(400, { error: 'Missing page_id.' });
      }

      return response(200, await completePage(body.page_id));
    }

    if (!body.db || !DB_IDS[body.db]) {
      return response(400, { error: `Unknown database: ${body.db || 'missing'}` });
    }

    const data = await queryAll(
      DB_IDS[body.db],
      body.filter,
      body.sorts,
      body.page_size,
    );

    return response(200, data);
  } catch (error) {
    console.error('Notion API error:', error);
    return response(error.statusCode || 500, {
      error: error.message || 'Notion request failed.',
    });
  }
};
