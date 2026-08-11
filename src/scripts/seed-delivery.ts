import { db } from '../infrastructure/db.js';

async function seedDelivery(): Promise<void> {
  const client = await db.connect();

  try {
    await client.query('begin');

    const companyResult = await client.query<{ id: string }>(
      `
      insert into companies (
        name,
        slug,
        vertical,
        evolution_instance,
        subscription_status,
        access_active,
        timezone
      )
      values (
        'Arles Delivery Demo',
        'delivery-demo',
        'delivery',
        'sim-delivery-demo',
        'active',
        true,
        'America/Sao_Paulo'
      )
      on conflict (slug)
      do update set
        name = excluded.name,
        vertical = excluded.vertical,
        evolution_instance = excluded.evolution_instance,
        subscription_status = 'active',
        access_active = true,
        timezone = excluded.timezone,
        updated_at = now()
      returning id::text
      `
    );

    const companyId = companyResult.rows[0]!.id;

    await client.query(
      `
      insert into delivery_store_info (
        company_id,
        store_name,
        short_description,
        avg_time,
        min_order,
        opening_hours,
        delivery_fee,
        neighborhoods,
        payment_methods,
        pix_key,
        ai_rules,
        updated_at
      )
      values (
        $1,
        'Pizzaria Arles Demo',
        'Pizzas e lanches para teste do Arles Engine.',
        '35 a 50 minutos',
        20.00,
        'Todos os dias, 18h às 23h',
        'R$ 5,00',
        'Centro e bairros próximos',
        'Pix, dinheiro e cartão',
        '11999999999',
        'Seja cordial, objetivo e faça uma pergunta por vez.',
        now()
      )
      on conflict (company_id)
      do update set
        store_name = excluded.store_name,
        short_description = excluded.short_description,
        avg_time = excluded.avg_time,
        min_order = excluded.min_order,
        opening_hours = excluded.opening_hours,
        delivery_fee = excluded.delivery_fee,
        neighborhoods = excluded.neighborhoods,
        payment_methods = excluded.payment_methods,
        pix_key = excluded.pix_key,
        ai_rules = excluded.ai_rules,
        updated_at = now()
      `,
      [companyId]
    );

    await client.query(
      'delete from delivery_products where company_id = $1',
      [companyId]
    );

    const products = [
      {
        category: 'Pizzas',
        name: 'Pizza Vegetariana',
        description: 'Mussarela, tomate, cebola, pimentão e azeitona.',
        price: 35
      },
      {
        category: 'Pizzas',
        name: 'Pizza Calabresa',
        description: 'Mussarela, calabresa, cebola e azeitona.',
        price: 38
      },
      {
        category: 'Lanches',
        name: 'X-Burger',
        description: 'Pão, hambúrguer, queijo e molho da casa.',
        price: 24
      },
      {
        category: 'Bebidas',
        name: 'Coca-Cola 2L',
        description: 'Refrigerante Coca-Cola 2 litros.',
        price: 14
      }
    ];

    for (const product of products) {
      await client.query(
        `
        insert into delivery_products (
          company_id,
          category,
          name,
          description,
          price,
          is_active
        )
        values ($1, $2, $3, $4, $5, true)
        `,
        [
          companyId,
          product.category,
          product.name,
          product.description,
          product.price
        ]
      );
    }

    await client.query('commit');

    console.log('');
    console.log('✅ Delivery de teste criado.');
    console.log(`Company ID: ${companyId}`);
    console.log('Slug: delivery-demo');
    console.log('Instância simulada: sim-delivery-demo');
    console.log('Produtos: Pizza Vegetariana, Pizza Calabresa, X-Burger, Coca-Cola 2L');
    console.log('');
    console.log('Próximo comando: npm run simulate:delivery');
    console.log('');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
    await db.end();
  }
}

try {
  await seedDelivery();
} catch (error) {
  console.error('❌ Falha criando Delivery de teste:', error);
  await db.end().catch(() => undefined);
  process.exit(1);
}
