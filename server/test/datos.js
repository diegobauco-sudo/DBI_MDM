/** Datos de prueba que cumplen las validaciones del panel (empresa completa, usuario con email, clave segura). */
export const usuario = (username, password, extra = {}) => ({
  username, password, fullName: `Nombre ${username}`, email: `${username.replace(/[^a-z0-9]/gi, '')}@ejemplo.com`, phone: '261 555 0101', ...extra,
});

export const empresa = (name, adminUser, adminPassword, extra = {}) => ({
  name,
  legalName: `${name} S.A.`,
  taxAddress: 'Av. San Martín 1000, Mendoza',
  taxCondition: 'ri',
  taxId: '30-71234567-1',
  email: `contacto@${name.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`,
  phone: '261 555 0000',
  ...(adminUser ? { admin: usuario(adminUser, adminPassword) } : {}),
  ...extra,
});
