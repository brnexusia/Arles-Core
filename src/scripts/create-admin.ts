import bcrypt from 'bcryptjs';
import { db } from '../infrastructure/db.js';

const email = String(process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const password = String(process.env.ADMIN_PASSWORD ?? '');
const name = String(process.env.ADMIN_NAME ?? 'Administrador Arles').trim();

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  throw new Error('Defina ADMIN_EMAIL com um e-mail válido.');
}
if (password.length < 10) {
  throw new Error('ADMIN_PASSWORD precisa ter pelo menos 10 caracteres.');
}

try {
  const passwordHash = await bcrypt.hash(password, 12);
  await db.query(
    `insert into auth_users(
       company_id,email,email_normalized,password_hash,name,role,created_at,updated_at
     ) values(null,$1,$1,$2,$3,'admin',now(),now())
     on conflict(email_normalized) do update set
       company_id = null,
       email = excluded.email,
       password_hash = excluded.password_hash,
       name = excluded.name,
       role = 'admin',
       updated_at = now()`,
    [email, passwordHash, name]
  );
  console.log(`Administrador ${email} criado/atualizado.`);
} finally {
  await db.end();
}

