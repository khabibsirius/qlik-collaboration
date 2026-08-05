namespace QlikCollaboration.Api.Models;

public class Comment
{
    public int Id { get; set; }
    public string AppId { get; set; } = "";
    public string SheetId { get; set; } = "";
    /// <summary>Qlik object ids the comment is attached to; empty = whole sheet.</summary>
    public string[] ObjectIds { get; set; } = [];
    /// <summary>Parent comment id for replies; null = top-level comment.</summary>
    public int? ParentId { get; set; }
    public string Author { get; set; } = "";
    public string Body { get; set; } = "";
    /// <summary>JSON snapshot of Qlik selections: [{"field":"Bank","values":["NBU"]}]</summary>
    public string? SelectionState { get; set; }
    public string Status { get; set; } = "new";
    public bool IsDeleted { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? UpdatedAt { get; set; }
    /// <summary>Files attached to this comment (Etap 3); filled by a second query.</summary>
    public List<Attachment> Attachments { get; set; } = [];
}
