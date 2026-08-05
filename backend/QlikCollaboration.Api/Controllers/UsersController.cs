using Dapper;
using Microsoft.AspNetCore.Mvc;
using Npgsql;

namespace QlikCollaboration.Api.Controllers;

[ApiController]
[Route("api/users")]
public class UsersController : ControllerBase
{
    private readonly NpgsqlDataSource _db;

    public UsersController(NpgsqlDataSource db) => _db = db;

    /// <summary>Known users (everyone who has ever commented) — feeds @mention autocomplete.</summary>
    [HttpGet]
    public async Task<IEnumerable<string>> Get()
    {
        await using var conn = await _db.OpenConnectionAsync();
        return await conn.QueryAsync<string>("SELECT username FROM users ORDER BY username");
    }
}
