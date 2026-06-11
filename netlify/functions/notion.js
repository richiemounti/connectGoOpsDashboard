const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const DB_IDS = {
  actions:   '9ad685dca6294a8e8978f1314d0b1ada',
  decisions: '216c56074fcb42d5b2b0ace5f606e1a0',
  learnings: '29360bfb014e80d68dc7fdd8ceb21875',
  milestones:'30560bfb014e80568a6dd1d280d91c88',
  pipeline:  '9c9aa106c37b4aab9276199a37773dba',
  boulders:  'fec81333ee4a4414b80662029c6d22f8',
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const { db, filter, sorts, page_size } = JSON.parse(event.body || '{}');

    if (!db || !DB_IDS[db]) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: `Unknown database: ${db}` }),
      };
    }

    const response = await notion.databases.query({
      database_id: DB_IDS[db],
      filter: filter || undefined,
      sorts: sorts || undefined,
      page_size: page_size || 100,
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(response),
    };
  } catch (err) {
    console.error('Notion API error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
