// ⚠️ DEPRECADO — NO USAR EN PRODUCCIÓN
// Este archivo ya NO contiene SQL ejecutable.
// Existió para aplicar políticas RLS fail-OPEN (OR current_tenant_id() IS NULL)
// y fue neutralizado. El script correcto para producción es migration.sql
// en la raíz del proyecto (políticas fail-CLOSED, sin la cláusula OR NULL).
// Ver MIGRATIONS_README.md para el proceso correcto de despliegue.
throw new Error('DEPRECADO: ejecuta migration.sql, no este script.')